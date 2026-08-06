import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { wrapD1WithHook } from "./db-interceptor";
import {
  setupExtensionsV2Tests,
  authHeaders,
  post,
  get,
  put,
  samplePayload,
  sampleDeveloper,
  seedDeveloper
} from "./harness";
import {
  insertUser,
  insertDeveloper,
  insertExtension,
  insertSubmission,
  getDeveloper,
  countExtensions,
  getExtension,
  getSubmission,
  bumpDeveloperOwnership
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", () => {
  const endpoint = { DEFAULTS: {} };
  const derivedFn = Object.assign(vi.fn(), { defaults: vi.fn(), endpoint });
  const request = Object.assign(vi.fn(), {
    defaults: vi.fn().mockReturnValue(derivedFn),
    endpoint
  });
  return { request };
});

let db: D1Database;

setupExtensionsV2Tests();

beforeEach(() => {
  db = env.DB_EXTENSIONS;
});

describe("Extensions API v2", () => {
  describe("GET /submissions/queue", () => {
    it("requires moderator access", async () => {
      const res = await get(
        "/extensions/v2/submissions/queue",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(403);
    });

    it("identifies invalid cursors", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      const res = await get(
        "/extensions/v2/submissions/queue?cursor=not-a-cursor",
        await authHeaders("mod-1")
      );
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "INVALID_CURSOR" }
      });
    });

    it("returns pending submissions for a moderator", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );

      const res = await get(
        "/extensions/v2/submissions/queue",
        await authHeaders("mod-1")
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: Array<{ status: string }> };
      expect(data.result).toHaveLength(1);
      expect(data.result[0].status).toBe("pending");
    });
  });

  describe("approve / reject", () => {
    it("does not approve a former owner's payload when ownership changes at approval", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      // ownership_epoch is captured on the submission at creation time and
      // only compared later, so unlike the deleteOwn/upsertOwn races below,
      // simply changing ownership before the approve call (rather than
      // mid-request) reproduces this exactly.
      await bumpDeveloperOwnership(db, "new-developer", "user-2");
      const approved = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(409);
      expect((await getSubmission(db, result.id))?.status).toBe("pending");
      expect(await countExtensions(db)).toBe(0);
    });

    it("does not approve a legacy pending submission with a reserved extension id", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const legacyPayload = samplePayload({ extensionId: "mine" });
      await insertSubmission(db, {
        id: "legacy-mine-submission",
        developer_id: "new-developer",
        submitted_by: "user-1",
        payload: JSON.stringify(legacyPayload),
        target_key: "mine"
      });

      const approved = await post(
        "/extensions/v2/submissions/legacy-mine-submission/approve",
        await authHeaders("mod-1"),
        {}
      );

      expect(approved.status).toBe(409);
      expect(await getSubmission(db, "legacy-mine-submission")).toMatchObject({
        status: "pending"
      });
      expect(await countExtensions(db)).toBe(0);
    });

    it("leaves the submission pending if the extension write-through fails mid-batch", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");

      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      // approve()'s three statements (submission status, developer, extension)
      // run as one atomic db.batch() call, so D1 itself rolls back the whole
      // thing on any failure - there's no app-level "revert" to test, and no
      // way to make the earlier statements really commit before this one
      // fails (see db-interceptor.ts). This verifies that guarantee end to
      // end: a failure on the last statement still leaves nothing committed.
      env.DB_EXTENSIONS = wrapD1WithHook(db, (sql) => {
        if (
          sql.includes("INSERT INTO") &&
          sql.includes("extensions") &&
          !sql.includes("extension_submissions")
        ) {
          throw new Error("simulated write-through failure");
        }
      });
      const approved = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(500);
      expect(await countExtensions(db)).toBe(0);

      const stored = await getSubmission(db, result.id);
      expect(stored?.status).toBe("pending");

      // Recovers cleanly once the underlying failure is gone.
      env.DB_EXTENSIONS = db;
      const retried = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(retried.status).toBe(200);
      expect(await countExtensions(db)).toBe(1);
    });

    it("approves a submission and it becomes visible via the v1 read path", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");

      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      const approved = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(200);
      const approvedBody = (await approved.json()) as {
        result: { status: string };
      };
      expect(approvedBody.result.status).toBe("approved");

      // v1's read-only API keeps calling this field "author" — its JSON
      // response shape is intentionally unchanged by the v2 rename.
      const v1Res = await get("/extensions/v1/new-ext", {});
      expect(v1Res.status).toBe(200);
      const v1Body = (await v1Res.json()) as {
        result: { id: string; author: { id: string } };
      };
      expect(v1Body.result.id).toBe("new-ext");
      expect(v1Body.result.author.id).toBe("new-developer");
    });

    it("blocks non-moderators from approving", async () => {
      await seedDeveloper("new-developer", "user-1");
      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      const res = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(403);
    });

    it("rejects approving a submission that is not pending", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      const secondApprove = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(secondApprove.status).toBe(409);
      // The second (raced) approve must not write through again.
      expect(await countExtensions(db)).toBe(1);
    });

    it("updates the existing row instead of duplicating it when an edit's id differs only by case", async () => {
      await insertDeveloper(db, {
        id: "owner-developer",
        type: "user",
        name: "Owner",
        url: null,
        owner_user_id: "owner-1"
      });
      // Legacy v1 data can have mixed-case ids; v2 submissions must be lowercase.
      await insertExtension(db, {
        id: "Existing-Ext",
        type: "mod",
        author_id: "owner-developer",
        name: "Existing",
        description: "d",
        releases: "[]",
        website: "https://e.com",
        license: '{"name":"MIT"}',
        icon_url: null,
        readme: "r",
        source: '{"type":"github","repo":"example/existing"}',
        version: "1.0.0",
        download_url: "https://e.com/d.zip"
      });
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("owner-1"),
        samplePayload({
          extensionId: "existing-ext",
          developerId: "owner-developer"
        })
      );
      const { result } = (await created.json()) as { result: { id: string } };

      const approved = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(200);

      expect(await countExtensions(db)).toBe(1);
      const stored = await getExtension(db, "Existing-Ext");
      expect(stored?.name).toBe("New Extension");
    });

    it("requires a review_note to reject", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      const res = await post(
        `/extensions/v2/submissions/${result.id}/reject`,
        await authHeaders("mod-1"),
        {}
      );
      expect(res.status).toBe(422);
    });

    it("rejects a submission with a note", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      const res = await post(
        `/extensions/v2/submissions/${result.id}/reject`,
        await authHeaders("mod-1"),
        { review_note: "Needs a valid license URL" }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { status: string } };
      expect(body.result.status).toBe("rejected");
      expect(await countExtensions(db)).toBe(0);
    });
  });

  describe("developer moderation", () => {
    it("binds approval to the exact profile revision reviewed", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper({ name: "Revision two" })
      );
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const stale = await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 1 }
      );
      expect(stale.status).toBe(409);

      const current = await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 2 }
      );
      expect(current.status).toBe(200);
    });

    it("does not turn an approval diagnosis database failure into not found", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      env.DB_EXTENSIONS = wrapD1WithHook(db, (sql) => {
        if (/^\s*select/i.test(sql) && /from\s+"developers"/i.test(sql)) {
          throw new Error("simulated approval diagnosis failure");
        }
      });

      const res = await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 999 }
      );
      env.DB_EXTENSIONS = db;

      expect(res.status).toBe(500);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "DATABASE_ERROR" }
      });
    });

    it("reports an inactive moderator when the account is deactivated during approval", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      let deactivated = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (
          !deactivated &&
          /update/i.test(sql) &&
          sql.includes("approved_at")
        ) {
          deactivated = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), "mod-1")
            .run();
        }
      });

      const res = await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 1 }
      );
      env.DB_EXTENSIONS = db;

      expect(deactivated).toBe(true);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "ACCOUNT_INACTIVE", message: "Active account required" }
      });
      expect((await getDeveloper(db, "dev-developer"))?.approved_at).toBeNull();
    });

    it("approves a developer and removes it from the unapproved list", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const approve = await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 1 }
      );
      expect(approve.status).toBe(200);
      const approveBody = (await approve.json()) as {
        result: { id: string; approved: boolean };
      };
      expect(approveBody.result).toEqual({
        id: "dev-developer",
        approved: true
      });

      const unapproved = await get(
        "/extensions/v2/developers/unapproved",
        await authHeaders("mod-1")
      );
      expect(unapproved.status).toBe(200);
      const unapprovedBody = (await unapproved.json()) as {
        result: Array<{ id: string }>;
      };
      expect(unapprovedBody.result.map((a) => a.id)).not.toContain(
        "dev-developer"
      );
    });

    it("404s approving a nonexistent developer", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const res = await post(
        "/extensions/v2/developers/no-such-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 1 }
      );
      expect(res.status).toBe(404);
    });

    it("blocks non-moderators from listing unapproved developers", async () => {
      const res = await get(
        "/extensions/v2/developers/unapproved",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(403);
    });

    it("lists every developer, approved and unapproved", async () => {
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
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 1 }
      );

      const res = await get(
        "/extensions/v2/developers",
        await authHeaders("mod-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: Array<{ id: string; approved: boolean }>;
      };
      expect(body.result.map((a) => a.id).sort()).toEqual([
        "dev-developer",
        "other-developer"
      ]);
      expect(body.result.find((a) => a.id === "dev-developer")?.approved).toBe(
        true
      );
      expect(
        body.result.find((a) => a.id === "other-developer")?.approved
      ).toBe(false);
    });

    it("blocks non-moderators from listing all developers", async () => {
      const res = await get(
        "/extensions/v2/developers",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(403);
    });

    it("blocks non-moderators from approving developers", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("user-1"),
        { expected_revision: 1 }
      );
      expect(res.status).toBe(403);
    });
  });

  describe("GET /developers/{id}/history", () => {
    it("records a history entry for a newly created profile", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const res = await get(
        "/extensions/v2/developers/dev-developer/history",
        await authHeaders("mod-1")
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: Array<{
          developer_id: string;
          name: string;
          changed_by: string;
        }>;
      };
      expect(data.result).toHaveLength(1);
      expect(data.result[0].developer_id).toBe("dev-developer");
      expect(data.result[0].name).toBe("Dev Developer");
      expect(data.result[0].changed_by).toBe("user-1");
    });

    it("orders entries newest-first and snapshots each write", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper({ name: "Original Name" })
      );
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper({ name: "Edited Name" })
      );
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const res = await get(
        "/extensions/v2/developers/dev-developer/history",
        await authHeaders("mod-1")
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: Array<{ name: string }>;
      };
      expect(data.result).toHaveLength(2);
      expect(data.result[0].name).toBe("Edited Name");
      expect(data.result[1].name).toBe("Original Name");
    });

    it("returns an empty array for a developer with no history", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const res = await get(
        "/extensions/v2/developers/no-such-developer/history",
        await authHeaders("mod-1")
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: unknown[] };
      expect(data.result).toEqual([]);
    });

    it("blocks non-moderators", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await get(
        "/extensions/v2/developers/dev-developer/history",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(403);
    });

    it("does not record history for a rejected write (id already taken)", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-2"),
        sampleDeveloper()
      );
      expect(res.status).toBe(409);

      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      const history = await get(
        "/extensions/v2/developers/dev-developer/history",
        await authHeaders("mod-1")
      );
      const data = (await history.json()) as { result: unknown[] };
      expect(data.result).toHaveLength(1);
    });
  });
});
