import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { request as ghRequest } from "@octokit/request";
import { wrapD1WithHook } from "./db-interceptor";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  post,
  get,
  put,
  samplePayload,
  sampleDeveloper,
  seedUnownedDeveloper,
  mockGithubEntity,
  mockGithubEntityNotFound
} from "./harness";
import {
  insertUser,
  insertDeveloper,
  insertSubmission,
  insertDeveloperClaim,
  getDeveloper,
  getSubmission,
  countDeveloperClaims,
  getDeveloperClaim,
  listDeveloperClaims,
  expireAllDeveloperTransfers
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

describe("Extensions API v2", () => {
  describe("developer transfers", () => {
    it("does not accept transfer capabilities in URL paths", async () => {
      const res = await post(
        "/extensions/v2/developers/transfers/secret-token/accept",
        await authHeaders("user-2")
      );
      expect(res.status).toBe(404);
    });

    it("initiating a second transfer revokes the first token", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const first = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      expect(first.status).toBe(200);
      const firstToken = ((await first.json()) as { result: { token: string } })
        .result.token;

      const second = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      expect(second.status).toBe(200);

      const acceptFirst = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token: firstToken }
      );
      expect(acceptFirst.status).toBe(404);
    });

    it("accepts a valid token, transferring ownership and clearing approval", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 1 }
      );

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(200);
      const accepted = (await accept.json()) as {
        result: { id: string; approved: boolean };
      };
      expect(accepted.result.id).toBe("dev-developer");
      expect(accepted.result.approved).toBe(false);
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-2"
      );

      const acceptAgain = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-3"),
        { token }
      );
      expect(acceptAgain.status).toBe(404);
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-2"
      );
    });

    it("does not turn a committed transfer into a database error if the profile is deleted before the response lookup", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      let deleted = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (
          !deleted &&
          /^\s*select/i.test(sql) &&
          /from\s+"developers"/i.test(sql)
        ) {
          deleted = true;
          await db
            .prepare("DELETE FROM developer_transfers WHERE developer_id = ?")
            .bind("dev-developer")
            .run();
          await db
            .prepare("DELETE FROM developers WHERE id = ?")
            .bind("dev-developer")
            .run();
        }
      });

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      env.DB_EXTENSIONS = db;

      expect(deleted).toBe(true);
      expect(accept.status).toBe(404);
      expect(await accept.json()).toMatchObject({
        error: { code: "NOT_FOUND" }
      });
    });

    it("rejects pending submissions and claims when ownership changes", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await insertDeveloperClaim(db, {
        id: "transfer-pending-claim",
        developer_id: "dev-developer",
        claimant_id: "user-3"
      });
      await insertSubmission(db, {
        id: "transfer-pending-submission",
        developer_id: "dev-developer",
        submitted_by: "user-3",
        payload: JSON.stringify(samplePayload({ developerId: "dev-developer" }))
      });

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(200);

      expect(
        await getDeveloperClaim(db, "transfer-pending-claim")
      ).toMatchObject({
        status: "rejected",
        review_note: "Ownership changed before review"
      });
      expect(
        await getSubmission(db, "transfer-pending-submission")
      ).toMatchObject({
        status: "rejected",
        review_note: "Ownership changed before review"
      });
    });

    it("reports an inactive owner when the account is deactivated during initiation", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      let tombstoned = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!tombstoned && sql.includes("INSERT INTO developer_transfers")) {
          tombstoned = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), "user-1")
            .run();
        }
      });

      const res = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      env.DB_EXTENSIONS = db;

      expect(tombstoned).toBe(true);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "ACCOUNT_INACTIVE", message: "Active account required" }
      });
    });

    it("reports an inactive recipient when the account is deactivated during acceptance", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      let deactivated = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!deactivated && sql.includes("UPDATE developer_transfers")) {
          deactivated = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), "user-2")
            .run();
        }
      });

      const res = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      env.DB_EXTENSIONS = db;

      expect(deactivated).toBe(true);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "ACCOUNT_INACTIVE", message: "Active account required" }
      });
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-1"
      );
    });

    it("doesn't inherit the previous owner's check_url cooldown after a transfer", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const usedCooldown = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      expect(usedCooldown.status).toBe(200);

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;
      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(200);

      // user-2 has never called check_url themselves — the previous
      // owner's still-active cooldown must not carry over onto them.
      const res = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-2")
      );
      expect(res.status).toBe(200);
    });

    it("clears GitHub verification on transfer — it described the previous owner's identity, not the new owner's", async () => {
      mockGithubEntity("User", "https://acme.example");
      await insertUser(db, {
        id: "user-1",
        github_login: "dev-developer",
        github_orgs: JSON.stringify([])
      });
      const created = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { ...sampleDeveloper(), URL: "https://acme.example" }
      );
      const createdBody = (await created.json()) as {
        result: {
          github_org_verified?: boolean;
          github_url_verified?: boolean;
        };
      };
      expect(createdBody.result.github_org_verified).toBe(true);
      expect(createdBody.result.github_url_verified).toBe(true);

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;
      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(200);
      const accepted = (await accept.json()) as {
        result: {
          github_org_verified?: boolean;
          github_url_verified?: boolean;
        };
      };
      expect(accepted.result.github_org_verified).toBeUndefined();
      expect(accepted.result.github_url_verified).toBeUndefined();
    });

    it("does not let replaying an already-used token reassign ownership away from a later owner", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const initiate1 = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token1 = ((await initiate1.json()) as { result: { token: string } })
        .result.token;

      const accept1 = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token: token1 }
      );
      expect(accept1.status).toBe(200);
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-2"
      );

      // dev-developer is legitimately handed off again, to a third user.
      const initiate2 = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-2")
      );
      const token2 = ((await initiate2.json()) as { result: { token: string } })
        .result.token;
      const accept2 = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-3"),
        { token: token2 }
      );
      expect(accept2.status).toBe(200);
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-3"
      );

      // Replaying the *first* (already-used) token, by the same user who
      // originally accepted it, must not silently reassign ownership back.
      const replay = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token: token1 }
      );
      expect(replay.status).toBe(404);
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-3"
      );
    });

    it("rejects an expired token", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      await expireAllDeveloperTransfers(db);

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(404);
    });

    it("rejects a revoked token", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      const revoke = await post(
        "/extensions/v2/developers/dev-developer/transfer/revoke",
        await authHeaders("user-1")
      );
      expect(revoke.status).toBe(200);

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(404);
    });

    it("rejects acceptance by a user who already owns a different profile", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-2"),
        sampleDeveloper({ id: "other-developer", name: "Other Developer" })
      );

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(409);
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-1"
      );
    });

    it("rejects the current owner accepting their own transfer link", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-1"),
        { token }
      );
      expect(accept.status).toBe(409);
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-1"
      );
    });

    it("blocks a non-owner from initiating a transfer", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("intruder")
      );
      expect(res.status).toBe(403);
    });

    it("blocks a non-owner from revoking a transfer", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );

      const res = await post(
        "/extensions/v2/developers/dev-developer/transfer/revoke",
        await authHeaders("intruder")
      );
      expect(res.status).toBe(403);
    });
  });

  describe("developer claims", () => {
    it("lets a user claim an unowned developer, visible to the claimant and moderators", async () => {
      await seedUnownedDeveloper("legacy-developer");

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        { note: "I'm the maintainer, see github.com/x" }
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as { result: { id: string } };

      const mine = await get(
        "/extensions/v2/developers/claims/mine",
        await authHeaders("user-1")
      );
      expect(mine.status).toBe(200);
      const mineData = (await mine.json()) as {
        result: Array<{ id: string; status: string }>;
      };
      expect(mineData.result.map((c) => c.id)).toEqual([created.result.id]);
      expect(mineData.result[0].status).toBe("pending");

      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      const pending = await get(
        "/extensions/v2/developers/claims",
        await authHeaders("mod-1")
      );
      expect(pending.status).toBe(200);
      const pendingData = (await pending.json()) as {
        result: Array<{ id: string; developer_name: string }>;
      };
      expect(pendingData.result.map((c) => c.id)).toEqual([created.result.id]);
      expect(pendingData.result[0].developer_name).toBe("Legacy Developer");
    });

    it("rejects claiming a developer that already has an owner", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await post(
        "/extensions/v2/developers/dev-developer/claim",
        await authHeaders("user-2"),
        {}
      );
      expect(res.status).toBe(409);
    });

    it.each([
      [
        "expired",
        JSON.stringify(["some-other-org"]),
        "2000-01-01T00:00:00.000Z"
      ],
      ["malformed", "not-json", "2099-01-01T00:00:00.000Z"]
    ])(
      "keeps a claim pending for manual review when %s GitHub membership evidence is unavailable",
      async (_state, github_orgs, github_orgs_expires_at) => {
        mockGithubEntity("Organization");
        await insertUser(db, {
          id: "user-1",
          github_login: "someone",
          github_orgs,
          github_orgs_expires_at
        });
        await insertDeveloper(db, {
          id: "acme-org",
          type: "organization",
          name: "Acme Org",
          url: null,
          owner_user_id: null
        });

        const res = await post(
          "/extensions/v2/developers/acme-org/claim",
          await authHeaders("user-1"),
          {}
        );

        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          result: {
            id: string;
            status: string;
            github_org_verified?: boolean;
            github_verification_note?: string;
          };
        };
        expect(body.result.status).toBe("pending");
        expect(body.result.github_org_verified).toBeUndefined();
        expect(body.result.github_verification_note).toContain(
          "could not be confirmed"
        );
        expect((await getDeveloper(db, "acme-org"))?.owner_user_id).toBeNull();

        const stored = await getDeveloperClaim(db, body.result.id);
        expect(stored?.status).toBe("pending");
        expect(stored?.github_org_verified).toBeNull();
      }
    );

    it("does not create a duplicate row for a second claim while one is already pending", async () => {
      await seedUnownedDeveloper("legacy-developer");

      const first = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(first.status).toBe(201);

      const second = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(second.status).toBe(409);
      expect(await countDeveloperClaims(db)).toBe(1);
    });

    it("does not re-check GitHub when replaying an already-pending claim", async () => {
      await seedUnownedDeveloper("legacy-developer");

      await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const callsAfterFirst = vi.mocked(ghRequest).mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      const second = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );

      expect(second.status).toBe(409);
      expect(vi.mocked(ghRequest).mock.calls.length).toBe(callsAfterFirst);
    });

    it("still verifies GitHub ownership on a retry after the prior claim was rejected", async () => {
      await seedUnownedDeveloper("legacy-developer");
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const first = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await first.json()) as { result: { id: string } })
        .result.id;
      await post(
        `/extensions/v2/developers/claims/${claimId}/reject`,
        await authHeaders("mod-1"),
        { review_note: "Not enough evidence" }
      );

      // Retrying now, with a GitHub identity that doesn't match: this must
      // still be blocked rather than silently creating an unverified claim
      // just because the prior (now-rejected) row cleared the pending guard.
      mockGithubEntity("Organization");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["some-other-org"])
      });

      const claimCountBefore = await countDeveloperClaims(db);
      const retry = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );

      expect(retry.status).toBe(403);
      const body = (await retry.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GITHUB_MISMATCH");
      expect(await countDeveloperClaims(db)).toBe(claimCountBefore);
    });

    it("rejects a claim from a user who already owns a different profile", async () => {
      await seedUnownedDeveloper("legacy-developer");
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(409);
    });

    it("reports an account deactivated during claim creation", async () => {
      await seedUnownedDeveloper("legacy-developer");
      const headers = await authHeaders("user-1");
      let deactivated = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (
          !deactivated &&
          sql.includes("developer_claims") &&
          sql.includes("INSERT")
        ) {
          deactivated = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), "user-1")
            .run();
        }
      });

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        headers,
        {}
      );
      env.DB_EXTENSIONS = db;

      expect(deactivated).toBe(true);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "ACCOUNT_INACTIVE", message: "Active account required" }
      });
      expect(await countDeveloperClaims(db)).toBe(0);
    });

    it("rolls back claim approval when a later ownership statement fails", async () => {
      await seedUnownedDeveloper("legacy-developer");
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const claim1 = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claim1Id = ((await claim1.json()) as { result: { id: string } })
        .result.id;
      const claim2 = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-2"),
        {}
      );
      const claim2Id = ((await claim2.json()) as { result: { id: string } })
        .result.id;
      const before = await getDeveloper(db, "legacy-developer");

      env.DB_EXTENSIONS = wrapD1WithHook(db, (sql) => {
        if (sql.includes("SET owner_user_id = ?")) {
          // Replace this item inside the real D1 batch, rather than throwing
          // from the interceptor before the batch is submitted. The claim
          // transition therefore executes first and this NOT NULL violation
          // proves D1 rolls it back.
          return db.prepare(
            "UPDATE developers SET name = NULL WHERE id = 'legacy-developer'"
          );
        }
      });

      const approve = await post(
        `/extensions/v2/developers/claims/${claim1Id}/approve`,
        await authHeaders("mod-1")
      );
      expect(approve.status).toBe(500);

      const after = await getDeveloper(db, "legacy-developer");
      expect(after?.owner_user_id).toBeNull();
      expect(after?.ownership_epoch).toBe(before?.ownership_epoch);
      expect(after?.content_revision).toBe(before?.content_revision);
      expect((await getDeveloperClaim(db, claim1Id))?.status).toBe("pending");
      expect((await getDeveloperClaim(db, claim2Id))?.status).toBe("pending");
    });

    it("approving a claim transfers ownership and auto-rejects competing claims", async () => {
      await seedUnownedDeveloper("legacy-developer");
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const claim1 = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claim1Id = ((await claim1.json()) as { result: { id: string } })
        .result.id;

      const claim2 = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-2"),
        {}
      );
      const claim2Id = ((await claim2.json()) as { result: { id: string } })
        .result.id;

      const approve = await post(
        `/extensions/v2/developers/claims/${claim1Id}/approve`,
        await authHeaders("mod-1")
      );
      expect(approve.status).toBe(200);
      const approved = (await approve.json()) as {
        result: { id: string; approved: boolean };
      };
      expect(approved.result.id).toBe("legacy-developer");
      expect(approved.result.approved).toBe(false);
      expect((await getDeveloper(db, "legacy-developer"))?.owner_user_id).toBe(
        "user-1"
      );

      const rejectedClaim = await getDeveloperClaim(db, claim2Id);
      expect(rejectedClaim?.status).toBe("rejected");
      expect(rejectedClaim?.review_note).toBe(
        "Another claim on this profile was approved"
      );
    });

    it("allows only one competing claim approval to win a race", async () => {
      await seedUnownedDeveloper("legacy-developer");
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const first = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const firstId = ((await first.json()) as { result: { id: string } })
        .result.id;
      const second = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-2"),
        {}
      );
      const secondId = ((await second.json()) as { result: { id: string } })
        .result.id;
      const headers = await authHeaders("mod-1");

      const approvals = await Promise.all([
        post(`/extensions/v2/developers/claims/${firstId}/approve`, headers),
        post(`/extensions/v2/developers/claims/${secondId}/approve`, headers)
      ]);

      expect(approvals.map(({ status }) => status).sort()).toEqual([200, 409]);
      const claims = await listDeveloperClaims(db);
      expect(claims.filter(({ status }) => status === "approved")).toHaveLength(
        1
      );
      expect(claims.filter(({ status }) => status === "rejected")).toHaveLength(
        1
      );
    });

    it("copies the claim's GitHub verification onto the developer row it transfers ownership to", async () => {
      await insertDeveloper(db, {
        id: "legacy-developer",
        type: "organization",
        name: "Legacy Developer",
        url: null,
        owner_user_id: null
      });
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      mockGithubEntity("Organization");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["legacy-developer"])
      });

      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;
      const claimRow = await getDeveloperClaim(db, claimId);
      expect(claimRow?.github_org_verified).toBe(1);

      const approve = await post(
        `/extensions/v2/developers/claims/${claimId}/approve`,
        await authHeaders("mod-1")
      );
      expect(approve.status).toBe(200);

      const developerRow = await getDeveloper(db, "legacy-developer");
      expect(developerRow?.github_org_verified).toBe(1);
      expect(developerRow?.github_verification_note).toBe(
        "Verified: caller's linked GitHub identity matches."
      );
      expect(developerRow?.github_verified_at).toBe(claimRow?.created_at);
    });

    it("lets a moderator reject a claim with a review note, leaving the developer unowned", async () => {
      await seedUnownedDeveloper("legacy-developer");
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;

      const reject = await post(
        `/extensions/v2/developers/claims/${claimId}/reject`,
        await authHeaders("mod-1"),
        { review_note: "Not enough evidence of maintainership" }
      );
      expect(reject.status).toBe(200);
      const rejected = (await reject.json()) as {
        result: { status: string; review_note?: string };
      };
      expect(rejected.result.status).toBe("rejected");
      expect(rejected.result.review_note).toBe(
        "Not enough evidence of maintainership"
      );
      expect(
        (await getDeveloper(db, "legacy-developer"))?.owner_user_id
      ).toBeNull();
    });

    it("verifies a claim when the claimant's linked GitHub org matches the developer id", async () => {
      await insertDeveloper(db, {
        id: "legacy-developer",
        type: "organization",
        name: "Legacy Developer",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("Organization");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["legacy-developer"])
      });

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBe(true);
    });

    it("verifies a claim when the claimant's linked GitHub login matches a user-type developer id", async () => {
      await insertDeveloper(db, {
        id: "legacy-user",
        type: "user",
        name: "Legacy User",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("User");
      await insertUser(db, {
        id: "user-1",
        github_login: "legacy-user",
        github_orgs: JSON.stringify([])
      });

      const res = await post(
        "/extensions/v2/developers/legacy-user/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBe(true);
    });

    it("blocks a claim outright when the claimant's linked GitHub identity doesn't match", async () => {
      await insertDeveloper(db, {
        id: "legacy-developer",
        type: "organization",
        name: "Legacy Developer",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("Organization");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["some-other-org"])
      });

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GITHUB_MISMATCH");
      expect(await countDeveloperClaims(db)).toBe(0);
    });

    it("falls back to unverified manual review when the claimant has no linked GitHub identity", async () => {
      await seedUnownedDeveloper("legacy-developer"); // type: "user"
      mockGithubEntity("User");
      // No row in users for user-1 — never linked GitHub.

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBeUndefined();
    });

    it("falls back to unverified manual review when organization membership evidence is stale", async () => {
      await insertDeveloper(db, {
        id: "legacy-developer",
        type: "organization",
        name: "Legacy Developer",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("Organization");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["legacy-developer"]),
        github_orgs_expires_at: "2000-01-01T00:00:00.000Z"
      });

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBeUndefined();
    });

    it("does not verify an organization claim for a whitespace-only GitHub login", async () => {
      await insertDeveloper(db, {
        id: "legacy-developer",
        type: "organization",
        name: "Legacy Developer",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("Organization");
      await insertUser(db, {
        id: "user-1",
        github_login: "   ",
        github_orgs: JSON.stringify(["legacy-developer"]),
        github_orgs_expires_at: "2099-01-01T00:00:00.000Z"
      });

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBeUndefined();
    });

    it("falls back to unverified manual review when no matching GitHub org/user exists for the id", async () => {
      await seedUnownedDeveloper("legacy-developer");
      mockGithubEntityNotFound();

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBeUndefined();
    });

    it("blocks non-moderators from the claims queue and review routes", async () => {
      await seedUnownedDeveloper("legacy-developer");
      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;

      const queue = await get(
        "/extensions/v2/developers/claims",
        await authHeaders("intruder")
      );
      expect(queue.status).toBe(403);

      const approve = await post(
        `/extensions/v2/developers/claims/${claimId}/approve`,
        await authHeaders("intruder")
      );
      expect(approve.status).toBe(403);

      const reject = await post(
        `/extensions/v2/developers/claims/${claimId}/reject`,
        await authHeaders("intruder"),
        { review_note: "no" }
      );
      expect(reject.status).toBe(403);
    });

    it("lets a claimant cancel their own pending claim", async () => {
      await seedUnownedDeveloper("legacy-developer");
      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;

      const cancel = await post(
        `/extensions/v2/developers/claims/${claimId}/cancel`,
        await authHeaders("user-1")
      );
      expect(cancel.status).toBe(200);
      const cancelled = (await cancel.json()) as {
        result: { id: string; cancelled: boolean };
      };
      expect(cancelled.result).toEqual({ id: claimId, cancelled: true });
      expect(await getDeveloperClaim(db, claimId)).toBeNull();
    });

    it("rejects cancelling a claim that belongs to someone else", async () => {
      await seedUnownedDeveloper("legacy-developer");
      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;

      const cancel = await post(
        `/extensions/v2/developers/claims/${claimId}/cancel`,
        await authHeaders("user-2")
      );
      expect(cancel.status).toBe(404);
      expect(await getDeveloperClaim(db, claimId)).not.toBeNull();
    });

    it("rejects cancelling a claim that is no longer pending", async () => {
      await seedUnownedDeveloper("legacy-developer");
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;
      await post(
        `/extensions/v2/developers/claims/${claimId}/reject`,
        await authHeaders("mod-1"),
        { review_note: "no" }
      );

      const cancel = await post(
        `/extensions/v2/developers/claims/${claimId}/cancel`,
        await authHeaders("user-1")
      );
      expect(cancel.status).toBe(404);
      expect((await getDeveloperClaim(db, claimId))?.status).toBe("rejected");
    });
  });
});
