import { describe, it, expect, vi } from "vitest";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
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
    it("syncs identity, exposes owner state, and lists owned extensions", async () => {
      const headers = await authHeaders("account-1");
      const synced = await put("/extensions/v2/users/me/identity", headers, {
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
      expect(await profile.json()).toEqual({
        result: { display_name: "Account Display" }
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

      const owned = await get("/extensions/v2/extensions/mine", headers);
      expect(owned.status).toBe(200);
      expect(await owned.json()).toMatchObject({
        result: [{ id: "account-extension" }],
        pagination: { has_more: false, next_cursor: null }
      });

      const filtered = await get(
        "/extensions/v2/extensions/mine?developer_id=someone-else",
        headers
      );
      expect(filtered.status).toBe(200);
      expect(await filtered.json()).toMatchObject({
        result: [{ id: "account-extension" }]
      });
    });

    it("validates a mine cursor before returning an empty owner page", async () => {
      const res = await get(
        "/extensions/v2/extensions/mine?cursor=not-a-cursor",
        await authHeaders("no-developer")
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        error: { code: "INVALID_CURSOR" }
      });
    });

    it("only reports GitHub as linked when both login and fresh evidence exist", async () => {
      const res = await put(
        "/extensions/v2/users/me/identity",
        await authHeaders("github-evidence-without-login"),
        {
          name: "No Login",
          email: "no-login@example.com",
          email_verified: true,
          picture: null,
          github_login: null,
          github_orgs: ["fossbilling"],
          github_orgs_expires_at: "2099-01-01T00:00:00.000Z"
        }
      );
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
        const res = await put(
          "/extensions/v2/users/me/identity",
          await authHeaders("impossible-org-date"),
          {
            name: "Impossible Date",
            email: "impossible-date@example.com",
            email_verified: true,
            picture: null,
            github_login: "someone",
            github_orgs: ["fossbilling"],
            github_orgs_expires_at
          }
        );

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

      const reactivated = await put(
        "/extensions/v2/users/me/identity",
        headers,
        {
          name: "Reactivated",
          email: "reactivated@example.com",
          email_verified: true,
          picture: null,
          github_login: null,
          github_orgs: null,
          github_orgs_expires_at: null
        }
      );
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
