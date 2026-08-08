import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { wrapD1WithHook } from "./db-interceptor";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  post,
  get,
  put,
  sampleContent,
  sampleCreate,
  sampleDeveloper,
  seedDeveloper
} from "./harness";
import {
  insertUser,
  insertDeveloper,
  insertExtension,
  insertUnpublishedExtension,
  insertRevision,
  getDeveloper,
  countExtensions,
  getExtension,
  getRevision,
  bumpDeveloperOwnership
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

// Creates an extension and returns the ids the review routes are addressed by.
async function createPending(
  user: string,
  overrides?: { extensionId?: string; name?: string }
): Promise<{ id: string; revisionId: string }> {
  const res = await post(
    "/extensions/v2/extensions",
    await authHeaders(user),
    sampleCreate(overrides)
  );
  expect(res.status).toBe(201);
  const { result } = (await res.json()) as {
    result: { id: string; revision_id: string };
  };
  return { id: result.id, revisionId: result.revision_id };
}

function reviewPath(
  id: string,
  revisionId: string,
  action: "approve" | "reject"
): string {
  return `/extensions/v2/extensions/${id}/revisions/${revisionId}/${action}`;
}

describe("Extensions API v2", () => {
  describe("GET /moderation/extensions", () => {
    it("requires moderator access", async () => {
      const res = await get(
        "/extensions/v2/moderation/extensions",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(403);
    });

    it("identifies invalid cursors", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      const res = await get(
        "/extensions/v2/moderation/extensions?cursor=not-a-cursor",
        await authHeaders("mod-1")
      );
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "INVALID_CURSOR" }
      });
    });

    it("returns pending revisions for a moderator", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      await createPending("user-1");

      const res = await get(
        "/extensions/v2/moderation/extensions",
        await authHeaders("mod-1")
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: Array<{ status: string; extension_id: string }>;
      };
      expect(data.result).toHaveLength(1);
      expect(data.result[0]).toMatchObject({
        status: "pending",
        extension_id: "new-ext"
      });
    });
  });

  describe("approve / reject", () => {
    it("does not approve a former owner's content when ownership changes at approval", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const { id, revisionId } = await createPending("user-1");

      // ownership_epoch is captured on the revision at creation time and only
      // compared later, so unlike the deleteOwn/upsertOwn races below, simply
      // changing ownership before the approve call (rather than mid-request)
      // reproduces this exactly.
      await bumpDeveloperOwnership(db, "new-developer", "user-2");
      const approved = await post(
        reviewPath(id, revisionId, "approve"),
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(409);
      expect((await getRevision(db, revisionId))?.status).toBe("pending");
      expect((await getExtension(db, id))?.published_at).toBeNull();
    });

    it("refuses a revision that belongs to a different extension", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const first = await createPending("user-1", { extensionId: "ext-one" });
      await createPending("user-1", { extensionId: "ext-two" });

      const res = await post(
        reviewPath("ext-two", first.revisionId, "approve"),
        await authHeaders("mod-1"),
        {}
      );

      expect(res.status).toBe(404);
      expect((await getRevision(db, first.revisionId))?.status).toBe("pending");
    });

    it("leaves the revision pending if the publish fails mid-batch", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const { id, revisionId } = await createPending("user-1");

      // approve()'s two statements (claim the revision, publish it into the
      // extension) run as one atomic db.batch() call, so D1 itself rolls back
      // the whole thing on any failure - there's no app-level "revert" to
      // test, and no way to make the earlier statement really commit before
      // this one fails (see db-interceptor.ts). This verifies that guarantee
      // end to end: a failure on the last statement still leaves nothing
      // committed.
      env.DB_EXTENSIONS = wrapD1WithHook(db, (sql) => {
        if (sql.includes("UPDATE extensions")) {
          throw new Error("simulated publish failure");
        }
      });
      const approved = await post(
        reviewPath(id, revisionId, "approve"),
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(500);
      expect((await getExtension(db, id))?.published_at).toBeNull();
      expect((await getRevision(db, revisionId))?.status).toBe("pending");

      // Recovers cleanly once the underlying failure is gone.
      env.DB_EXTENSIONS = db;
      const retried = await post(
        reviewPath(id, revisionId, "approve"),
        await authHeaders("mod-1"),
        {}
      );
      expect(retried.status).toBe(200);
      expect((await getExtension(db, id))?.published_at).not.toBeNull();
    });

    it("publishes on approval and it becomes visible via the v1 read path", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const { id, revisionId } = await createPending("user-1");

      // Until approval the extension exists but is in neither catalogue.
      expect((await get("/extensions/v1/new-ext", {})).status).toBe(404);
      expect((await get("/extensions/v2/extensions/new-ext", {})).status).toBe(
        404
      );

      const approved = await post(
        reviewPath(id, revisionId, "approve"),
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(200);
      const approvedBody = (await approved.json()) as {
        result: { status: string };
      };
      expect(approvedBody.result.status).toBe("approved");

      const stored = await getExtension(db, "new-ext");
      expect(stored?.published_at).not.toBeNull();
      expect(stored?.published_revision_id).toBe(revisionId);
      expect(stored?.name).toBe("New Extension");

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

    // Approving an extension used to rewrite the developer row from the
    // submission payload and clear its approval as a side effect. A revision
    // carries extension content only, so there is nothing left to write.
    it("does not touch the developer profile", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const before = await getDeveloper(db, "new-developer");
      const { id, revisionId } = await createPending("user-1");

      expect(
        (
          await post(
            reviewPath(id, revisionId, "approve"),
            await authHeaders("mod-1"),
            {}
          )
        ).status
      ).toBe(200);

      expect(await getDeveloper(db, "new-developer")).toEqual(before);
    });

    it("keeps published_at at the first publication across later edits", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const first = await createPending("user-1");
      await post(
        reviewPath(first.id, first.revisionId, "approve"),
        await authHeaders("mod-1"),
        {}
      );
      const afterFirst = await getExtension(db, first.id);

      const edit = await put(
        `/extensions/v2/extensions/${first.id}`,
        await authHeaders("user-1"),
        sampleContent({ name: "Second Version" })
      );
      const { result } = (await edit.json()) as {
        result: { revision_id: string };
      };
      expect(
        (
          await post(
            reviewPath(first.id, result.revision_id, "approve"),
            await authHeaders("mod-1"),
            {}
          )
        ).status
      ).toBe(200);

      const afterEdit = await getExtension(db, first.id);
      expect(afterEdit?.published_at).toBe(afterFirst?.published_at);
      expect(afterEdit?.published_revision_id).toBe(result.revision_id);
      expect(afterEdit?.name).toBe("Second Version");
    });

    // requireModerator() runs before the write; the statement repeats the
    // active check, so the zero-row diagnosis has to recognise it rather than
    // reporting the revision as no longer pending.
    it.each(["approve", "reject"] as const)(
      "reports 403 when the moderator is deactivated mid-%s",
      async (action) => {
        await insertUser(db, { id: "mod-1", is_moderator: 1 });
        await seedDeveloper("new-developer", "user-1");
        const { id, revisionId } = await createPending("user-1");
        const headers = await authHeaders("mod-1");

        let done = false;
        env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
          if (!done && sql.includes("extension_revisions")) {
            done = true;
            await db
              .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
              .bind(new Date().toISOString(), "mod-1")
              .run();
          }
        });

        const res = await post(reviewPath(id, revisionId, action), headers, {
          review_note: "note"
        });

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toMatchObject({
          error: { code: "ACCOUNT_INACTIVE" }
        });
        // The revision is untouched, which is why 409 was the wrong answer.
        expect((await getRevision(db, revisionId))?.status).toBe("pending");
      }
    );

    // Revision history outlives the rules its content was written under, so
    // the response schema tolerates a stored revision with no releases. The
    // public catalogue does not, which makes approval the boundary that has to
    // re-check rather than trust submission-time validation.
    it("refuses to publish a revision that predates current content rules", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      await insertUnpublishedExtension(db, {
        id: "legacy-ext",
        developer_id: "new-developer"
      });
      await insertRevision(db, {
        id: "legacy-revision",
        extension_id: "legacy-ext",
        developer_id: "new-developer",
        submitted_by: "user-1",
        // Carried through by migration 0021 from a submission that predates
        // the releases requirement.
        content: JSON.stringify({ ...sampleContent(), releases: [] })
      });

      const res = await post(
        reviewPath("legacy-ext", "legacy-revision", "approve"),
        await authHeaders("mod-1"),
        {}
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "CONFLICT" }
      });
      expect((await getExtension(db, "legacy-ext"))?.published_at).toBeNull();

      // But it is still readable as history, with the empty releases intact.
      const history = await get(
        "/extensions/v2/extensions/legacy-ext/revisions",
        await authHeaders("user-1")
      );
      expect(history.status).toBe(200);
      const body = (await history.json()) as {
        result: Array<{ content: { releases: unknown[] } }>;
      };
      expect(body.result[0].content.releases).toEqual([]);
    });

    // reviewed_at is only second-granular, so two reviews can share one and
    // the tie-break decides which decision the owner sees.
    it("reports the newer decision when two reviews share a timestamp", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const first = await createPending("user-1");
      const mod = await authHeaders("mod-1");

      await post(reviewPath(first.id, first.revisionId, "reject"), mod, {
        review_note: "first decision"
      });
      const second = await put(
        `/extensions/v2/extensions/${first.id}`,
        await authHeaders("user-1"),
        sampleContent({ name: "Second" })
      );
      const secondId = (
        (await second.json()) as { result: { revision_id: string } }
      ).result.revision_id;
      await post(reviewPath(first.id, secondId, "reject"), mod, {
        review_note: "second decision"
      });

      // Force the collision the tie-break exists for.
      await db
        .prepare("UPDATE extension_revisions SET reviewed_at = ?")
        .bind("2026-01-01 00:00:00")
        .run();

      const mine = await get(
        `/extensions/v2/extensions/mine/${first.id}`,
        await authHeaders("user-1")
      );
      await expect(mine.json()).resolves.toMatchObject({
        result: { last_review: { review_note: "second decision" } }
      });
    });

    it("blocks non-moderators from approving", async () => {
      await seedDeveloper("new-developer", "user-1");
      const { id, revisionId } = await createPending("user-1");

      const res = await post(
        reviewPath(id, revisionId, "approve"),
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(403);
    });

    it("rejects approving a revision that is not pending", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const { id, revisionId } = await createPending("user-1");
      const headers = await authHeaders("mod-1");

      await post(reviewPath(id, revisionId, "approve"), headers, {});
      const secondApprove = await post(
        reviewPath(id, revisionId, "approve"),
        headers,
        {}
      );
      expect(secondApprove.status).toBe(409);
      expect(await countExtensions(db)).toBe(1);
    });

    // Legacy v1 data can have mixed-case ids. The id now comes from the path
    // rather than a payload field, so an edit addresses that row directly and
    // cannot fork a second, lowercase one.
    it("edits a mixed-case legacy extension in place", async () => {
      await insertDeveloper(db, {
        id: "owner-developer",
        type: "user",
        name: "Owner",
        url: null,
        owner_user_id: "owner-1"
      });
      await insertExtension(db, {
        id: "Existing-Ext",
        developer_id: "owner-developer",
        name: "Existing"
      });
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

      const edit = await put(
        "/extensions/v2/extensions/Existing-Ext",
        await authHeaders("owner-1"),
        sampleContent()
      );
      expect(edit.status).toBe(202);
      const { result } = (await edit.json()) as {
        result: { revision_id: string };
      };

      const approved = await post(
        reviewPath("Existing-Ext", result.revision_id, "approve"),
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(200);

      expect(await countExtensions(db)).toBe(1);
      expect((await getExtension(db, "Existing-Ext"))?.name).toBe(
        "New Extension"
      );
    });

    it("requires a review_note to reject", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const { id, revisionId } = await createPending("user-1");

      const res = await post(
        reviewPath(id, revisionId, "reject"),
        await authHeaders("mod-1"),
        {}
      );
      expect(res.status).toBe(422);
    });

    it("rejects a revision with a note and leaves the extension unpublished", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const { id, revisionId } = await createPending("user-1");

      const res = await post(
        reviewPath(id, revisionId, "reject"),
        await authHeaders("mod-1"),
        { review_note: "Needs a valid license URL" }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { status: string } };
      expect(body.result.status).toBe("rejected");

      // The record survives so the owner can see the reason and resubmit.
      const stored = await getExtension(db, id);
      expect(stored).not.toBeNull();
      expect(stored?.published_at).toBeNull();

      const mine = await get(
        `/extensions/v2/extensions/mine/${id}`,
        await authHeaders("user-1")
      );
      await expect(mine.json()).resolves.toMatchObject({
        result: {
          published: null,
          pending_revision: null,
          last_review: {
            status: "rejected",
            review_note: "Needs a valid license URL"
          }
        }
      });
    });

    it("lets the owner resubmit after a rejection", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const { id, revisionId } = await createPending("user-1");
      await post(
        reviewPath(id, revisionId, "reject"),
        await authHeaders("mod-1"),
        { review_note: "no" }
      );

      const retry = await put(
        `/extensions/v2/extensions/${id}`,
        await authHeaders("user-1"),
        sampleContent({ name: "Fixed" })
      );
      expect(retry.status).toBe(202);
    });

    // Both review-note bodies are strict: the reviewer decision is derived
    // from the route, never from the payload, so an unknown key is a client
    // mistake rather than something to drop silently.
    it("rejects an unknown field in the approve and reject bodies", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const { id, revisionId } = await createPending("user-1");
      const headers = await authHeaders("mod-1");

      for (const action of ["approve", "reject"] as const) {
        const res = await post(reviewPath(id, revisionId, action), headers, {
          review_note: "looks fine",
          reviewer_id: "someone-else"
        });

        expect(res.status).toBe(422);
        const body = (await res.json()) as {
          error: { details: Array<{ code: string; path: PropertyKey[] }> };
        };
        expect(body.error.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "unrecognized_keys", path: [] })
          ])
        );
      }

      expect(await getRevision(db, revisionId)).toMatchObject({
        status: "pending"
      });
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
