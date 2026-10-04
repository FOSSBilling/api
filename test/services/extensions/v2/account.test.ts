import app from "../../../../src/app";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { signAssertion } from "../../../lib/auth/assertion-helper";
import { describe, it, expect, vi } from "vitest";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  identityHeaders,
  syncIdentity,
  get,
  put,
  patch,
  del,
  sampleContent,
  sampleDeveloper,
  seedDeveloper,
  seedUnownedDeveloper,
  seedOwnedExtension
} from "./harness";
import {
  insertUser,
  insertDeveloper,
  insertExtension,
  insertUnpublishedExtension,
  insertRevision,
  insertDeveloperClaim,
  hasDeveloper,
  getRevision,
  getDeveloperClaim,
  insertDeveloperTransfer,
  insertDeveloperHistory,
  listDeveloperTransfers,
  listDeveloperClaims,
  listDeveloperHistory
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

describe("Extensions API v2", () => {
  describe("API-owned account projection", () => {
    const identity = {
      name: "Trusted User",
      email: "trusted@example.com",
      email_verified: true,
      picture: "https://example.com/trusted.png",
      github_login: "trusted",
      github_orgs: ["trusted-org"],
      github_orgs_expires_at: "2099-01-01T00:00:00.000Z"
    };

    it("rejects ordinary assertions before storing attacker-selected identity", async () => {
      const response = await put(
        "/extensions/v2/users/me/identity",
        await authHeaders("attacker"),
        identity
      );
      expect(response.status).toBe(403);
      const row = await db
        .prepare("SELECT github_login FROM users WHERE id = ?")
        .bind("attacker")
        .first();
      expect(row).toEqual({ github_login: null });
    });

    it.each([
      ["name", "Forged"],
      ["email", "forged@example.com"],
      ["email_verified", false],
      ["picture", null],
      ["github_login", "victim"],
      ["github_orgs", ["victim-org"]],
      ["github_orgs_expires_at", "2099-02-01T00:00:00.000Z"]
    ])("rejects tampering with signed %s", async (field, value) => {
      const headers = await identityHeaders("new-identity", identity);
      const response = await put("/extensions/v2/users/me/identity", headers, {
        ...identity,
        [field as string]: value
      });
      expect(response.status).toBe(403);
      expect(
        await db
          .prepare("SELECT id FROM users WHERE id = ?")
          .bind("new-identity")
          .first()
      ).toBeNull();
    });

    it.each([
      " " + JSON.stringify(identity),
      JSON.stringify(identity).replace(
        '"github_login":"trusted"',
        '"github_login":"trusted","github_login":"victim"'
      ),
      JSON.stringify(identity).replace('"github_login"', '"github_\\u006cogin"')
    ])(
      "rejects changed JSON bytes, including aliases and duplicate fields",
      async (rawBody) => {
        const ctx = createExecutionContext();
        const res = await app.request(
          "/extensions/v2/users/me/identity",
          {
            method: "PUT",
            headers: await identityHeaders("raw-body", identity),
            body: rawBody
          },
          env,
          ctx
        );
        await waitOnExecutionContext(ctx);
        expect(res.status).toBe(403);
      }
    );

    it("accepts exact signed UTF-8 JSON bytes and preserves schema errors", async () => {
      for (const [body, status] of [
        [{ ...identity, name: "Renée" }, 200],
        [{ ...identity, extra: true }, 422]
      ] as const) {
        const rawBody = JSON.stringify(body, null, 2);
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(rawBody)
        );
        const bodySha256 = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");
        const token = await signAssertion("test-assertion-signing-secret", {
          sub: "utf8-body",
          purpose: "identity-sync",
          bodySha256
        });
        const ctx = createExecutionContext();
        const res = await app.request(
          "/extensions/v2/users/me/identity",
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            body: rawBody
          },
          env,
          ctx
        );
        await waitOnExecutionContext(ctx);
        expect(res.status).toBe(status);
      }
    });

    it("keeps identity proofs out of user API authorization", async () => {
      const response = await get(
        "/extensions/v2/users/me",
        await identityHeaders("service-sub", identity)
      );
      expect(response.status).toBe(401);
    });

    it("creates a new account from signed identity and caps membership freshness", async () => {
      const before = Date.now();
      const response = await syncIdentity("new-signed-user", identity);
      expect(response.status).toBe(200);
      const row = await db
        .prepare(
          "SELECT github_login, github_orgs_expires_at FROM users WHERE id = ?"
        )
        .bind("new-signed-user")
        .first<{ github_login: string; github_orgs_expires_at: string }>();
      expect(row?.github_login).toBe("trusted");
      expect(Date.parse(row!.github_orgs_expires_at)).toBeGreaterThanOrEqual(
        before + 3600000
      );
      expect(Date.parse(row!.github_orgs_expires_at)).toBeLessThanOrEqual(
        Date.now() + 3600000
      );
    });

    it("does not extend a shorter signed membership expiry", async () => {
      const expiry = new Date(Date.now() + 60000).toISOString();
      expect(
        (
          await syncIdentity("short-evidence", {
            ...identity,
            github_orgs_expires_at: expiry
          })
        ).status
      ).toBe(200);
      const row = await db
        .prepare("SELECT github_orgs_expires_at FROM users WHERE id = ?")
        .bind("short-evidence")
        .first();
      expect(row).toEqual({ github_orgs_expires_at: expiry });
    });

    it("syncs identity, exposes owner state, and lists owned extensions", async () => {
      const headers = await authHeaders("account-1");
      const synced = await syncIdentity("account-1", {
        name: "Account User",
        email: "account@example.com",
        email_verified: true,
        picture: "https://example.com/avatar.png",
        github_login: "account-user",
        github_orgs: ["fossbilling"],
        github_orgs_expires_at: "2099-01-01T00:00:00.000Z"
      });
      expect(synced.status).toBe(200);
      expect(await synced.json()).toMatchObject({
        result: {
          github_linked: true,
          is_moderator: false,
          active: true
        }
      });

      const profile = await patch("/extensions/v2/users/me", headers, {
        display_name: "Account Display"
      });
      expect(profile.status).toBe(200);
      expect(await profile.json()).toMatchObject({
        result: {
          display_name: "Account Display",
          github_linked: true,
          is_moderator: false,
          active: true
        }
      });

      const developer = await get("/extensions/v2/developers/me", headers);
      expect(developer.status).toBe(200);
      expect(await developer.json()).toEqual({ result: null });

      await insertDeveloper(db, {
        id: "account-developer",
        type: "user",
        name: "Account Developer",
        owner_user_id: "account-1"
      });
      await insertExtension(db, {
        id: "account-extension",
        type: "mod",
        developer_id: "account-developer",
        name: "Account Extension",
        description: "description",
        releases: "[]",
        website: "https://example.com",
        license: '{"name":"MIT"}',
        icon_url: null,
        readme: "# Readme",
        source: '{"type":"github","repo":"example/account"}',
        version: "1.0.0",
        download_url: "https://example.com/download.zip"
      });

      const owned = await get("/extensions/v2/extensions?scope=mine", headers);
      expect(owned.status).toBe(200);
      expect(await owned.json()).toMatchObject({
        result: [{ id: "account-extension" }],
        pagination: { has_more: false, next_cursor: null }
      });

      const filtered = await get(
        "/extensions/v2/extensions?scope=mine&developer_id=someone-else",
        headers
      );
      expect(filtered.status).toBe(422);
      await expect(filtered.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_ERROR" }
      });
    });

    it("validates a mine cursor before returning an empty owner page", async () => {
      const res = await get(
        "/extensions/v2/extensions?scope=mine&cursor=not-a-cursor",
        await authHeaders("no-developer")
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        error: { code: "INVALID_CURSOR" }
      });
    });

    it("only reports GitHub as linked when both login and fresh evidence exist", async () => {
      const res = await syncIdentity("github-evidence-without-login", {
        name: "No Login",
        email: "no-login@example.com",
        email_verified: true,
        picture: null,
        github_login: null,
        github_orgs: ["fossbilling"],
        github_orgs_expires_at: "2099-01-01T00:00:00.000Z"
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        result: { github_linked: false }
      });
    });

    it.each([
      ["an impossible calendar day", "2099-02-30T00:00:00.000Z"],
      ["an out-of-range hour", "2099-01-01T24:00:00.000Z"],
      ["an out-of-range offset", "2099-01-01T00:00:00.000+24:00"]
    ])(
      "does not treat %s as usable organization evidence",
      async (_description, github_orgs_expires_at) => {
        const res = await syncIdentity("impossible-org-date", {
          name: "Impossible Date",
          email: "impossible-date@example.com",
          email_verified: true,
          picture: null,
          github_login: "someone",
          github_orgs: ["fossbilling"],
          github_orgs_expires_at
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          result: { github_linked: false }
        });
        const row = await db
          .prepare(
            "SELECT github_orgs, github_orgs_expires_at FROM users WHERE id = ?"
          )
          .bind("impossible-org-date")
          .first<{
            github_orgs: string | null;
            github_orgs_expires_at: string | null;
          }>();
        expect(row).toEqual({
          github_orgs: null,
          github_orgs_expires_at: null
        });
      }
    );

    it("tombstones and later reactivates an account", async () => {
      const headers = await authHeaders("delete-me");
      const deleted = await del("/extensions/v2/users/me", headers);
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ result: { deleted: true } });

      const afterDelete = await get("/extensions/v2/users/me", headers);
      expect(afterDelete.status).toBe(200);
      expect(await afterDelete.json()).toMatchObject({
        result: { active: false, display_name: null }
      });
      const row = await db
        .prepare(
          "SELECT name, email, email_verified, picture, display_name, is_moderator, github_login, github_orgs, github_orgs_expires_at, deleted_at FROM users WHERE id = ?"
        )
        .bind("delete-me")
        .first<{
          name: string | null;
          email: string | null;
          email_verified: number;
          picture: string | null;
          display_name: string | null;
          is_moderator: number;
          github_login: string | null;
          github_orgs: string | null;
          github_orgs_expires_at: string | null;
          deleted_at: string | null;
        }>();
      expect(row).toMatchObject({
        name: null,
        email: null,
        email_verified: 0,
        picture: null,
        display_name: null,
        is_moderator: 0,
        github_login: null,
        github_orgs: null,
        github_orgs_expires_at: null
      });
      expect(row?.deleted_at).toBeTruthy();

      const blockedWrite = await put(
        "/extensions/v2/developers/me",
        headers,
        sampleDeveloper({ id: "deleted-developer" })
      );
      expect(blockedWrite.status).toBe(403);
      expect(await blockedWrite.json()).toMatchObject({
        error: { code: "ACCOUNT_INACTIVE" }
      });

      const reactivated = await syncIdentity("delete-me", {
        name: "Reactivated",
        email: "reactivated@example.com",
        email_verified: true,
        picture: null,
        github_login: null,
        github_orgs: null,
        github_orgs_expires_at: null
      });
      expect(reactivated.status).toBe(200);
      expect(await reactivated.json()).toMatchObject({
        result: { active: true, display_name: null }
      });
    });

    it("blocks deletion while published extensions remain owned", async () => {
      await seedOwnedExtension();
      const headers = await authHeaders("owner-1");
      const deleted = await del("/extensions/v2/users/me", headers);
      expect(deleted.status).toBe(409);
      const row = await db
        .prepare("SELECT deleted_at FROM users WHERE id = ?")
        .bind("owner-1")
        .first<{ deleted_at: string | null }>();
      expect(row?.deleted_at).toBeNull();
    });

    it("blocks deletion while an unpublished extension is still owned", async () => {
      await seedDeveloper("pending-developer", "pending-owner");
      await insertUnpublishedExtension(db, {
        id: "pending-ext",
        developer_id: "pending-developer"
      });
      await insertRevision(db, {
        id: "pending-revision",
        extension_id: "pending-ext",
        developer_id: "pending-developer",
        submitted_by: "pending-owner",
        content: JSON.stringify(sampleContent())
      });

      const deleted = await del(
        "/extensions/v2/users/me",
        await authHeaders("pending-owner")
      );
      expect(deleted.status).toBe(409);
      expect(await getRevision(db, "pending-revision")).toMatchObject({
        status: "pending"
      });
      const user = await db
        .prepare("SELECT deleted_at FROM users WHERE id = ?")
        .bind("pending-owner")
        .first<{ deleted_at: string | null }>();
      expect(user?.deleted_at).toBeNull();
    });

    it("cancels pending work, removes disposable ownership rows, and preserves history", async () => {
      await seedDeveloper("cleanup-developer", "cleanup-user");
      await seedUnownedDeveloper("claim-target");
      await insertDeveloperTransfer(db, {
        id: "cleanup-transfer",
        developer_id: "cleanup-developer",
        token_hash: "cleanup-token-hash",
        created_by: "cleanup-user",
        expires_at: "2099-01-01 00:00:00"
      });
      await insertDeveloperClaim(db, {
        id: "cleanup-owned-claim",
        developer_id: "cleanup-developer",
        claimant_id: "cleanup-user"
      });
      await insertDeveloperClaim(db, {
        id: "cleanup-pending-claim",
        developer_id: "claim-target",
        claimant_id: "cleanup-user"
      });
      // Under claim-target, a developer this user does not own - which is the
      // only way a pending revision survives the "no owned extensions" guard.
      await insertUnpublishedExtension(db, {
        id: "cleanup-pending-ext",
        developer_id: "claim-target"
      });
      await insertRevision(db, {
        id: "cleanup-pending-revision",
        extension_id: "cleanup-pending-ext",
        developer_id: "claim-target",
        submitted_by: "cleanup-user",
        content: JSON.stringify(sampleContent())
      });
      await insertDeveloperHistory(db, {
        id: "cleanup-history",
        developer_id: "cleanup-developer",
        type: "user",
        name: "Before deletion",
        changed_by: "cleanup-user"
      });
      await insertUser(db, {
        id: "cleanup-user",
        is_moderator: 1,
        github_login: "cleanup-user",
        github_orgs: '["fossbilling"]'
      });
      await db
        .prepare(
          `UPDATE users
           SET name = ?, email = ?, email_verified = 1, picture = ?, display_name = ?
           WHERE id = ?`
        )
        .bind(
          "Cleanup User",
          "cleanup@example.com",
          "https://example.com/cleanup.png",
          "Cleanup",
          "cleanup-user"
        )
        .run();

      const deleted = await del(
        "/extensions/v2/users/me",
        await authHeaders("cleanup-user")
      );
      expect(deleted.status).toBe(200);

      expect(await hasDeveloper(db, "cleanup-developer")).toBe(false);
      expect(await listDeveloperTransfers(db)).toEqual([]);
      expect(
        (await listDeveloperClaims(db)).find(
          ({ id }) => id === "cleanup-owned-claim"
        )
      ).toBeUndefined();
      expect(await getRevision(db, "cleanup-pending-revision")).toMatchObject({
        status: "rejected",
        review_note: "Submitter account deleted"
      });
      expect(
        await getDeveloperClaim(db, "cleanup-pending-claim")
      ).toMatchObject({
        status: "rejected",
        review_note: "Claimant account deleted"
      });
      expect(await listDeveloperHistory(db)).toEqual([
        expect.objectContaining({
          id: "cleanup-history",
          developer_id: "cleanup-developer",
          changed_by: "cleanup-user"
        })
      ]);

      const user = await db
        .prepare(
          `SELECT name, email, email_verified, picture, display_name,
                  is_moderator, github_login, github_orgs,
                  github_orgs_expires_at, deleted_at
           FROM users WHERE id = ?`
        )
        .bind("cleanup-user")
        .first<Record<string, string | number | null>>();
      expect(user).toMatchObject({
        name: null,
        email: null,
        email_verified: 0,
        picture: null,
        display_name: null,
        is_moderator: 0,
        github_login: null,
        github_orgs: null,
        github_orgs_expires_at: null
      });
      expect(user?.deleted_at).toBeTruthy();
    });

    it("rolls back the tombstone and cleanup when a batch statement fails", async () => {
      await seedDeveloper("rollback-developer", "rollback-user");
      await insertDeveloperTransfer(db, {
        id: "rollback-transfer",
        developer_id: "rollback-developer",
        token_hash: "rollback-token-hash",
        created_by: "rollback-user",
        expires_at: "2099-01-01 00:00:00"
      });
      await db
        .prepare(
          `CREATE TRIGGER deletion_test_failure
           BEFORE DELETE ON developers
           BEGIN
             SELECT RAISE(ABORT, 'deletion test failure');
           END`
        )
        .run();

      try {
        const deleted = await del(
          "/extensions/v2/users/me",
          await authHeaders("rollback-user")
        );
        expect(deleted.status).toBe(500);
      } finally {
        await db.prepare("DROP TRIGGER deletion_test_failure").run();
      }

      expect(await hasDeveloper(db, "rollback-developer")).toBe(true);
      expect(await listDeveloperTransfers(db)).toEqual([
        expect.objectContaining({ id: "rollback-transfer" })
      ]);
      const user = await db
        .prepare("SELECT deleted_at FROM users WHERE id = ?")
        .bind("rollback-user")
        .first<{ deleted_at: string | null }>();
      expect(user?.deleted_at).toBeNull();
    });
  });
});
