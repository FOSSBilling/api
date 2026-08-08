import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { wrapD1WithHook } from "./db-interceptor";
import { OwnedExtensionSchema } from "../../../../src/services/extensions/v2/schemas/extensions";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  post,
  get,
  put,
  del,
  sampleContent,
  sampleCreate,
  seedDeveloper,
  seedOwnedExtension
} from "./harness";
import {
  countExtensions,
  countRevisions,
  insertUser,
  getExtension,
  getRevision,
  insertDeveloper,
  insertExtension,
  listRevisions
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

// Adopted pre-v2 rows can carry mixed-case ids; new ones cannot, since
// lowercaseId() rejects them at validation.
async function seedMixedCaseExtension() {
  await insertDeveloper(db, {
    id: "owner-developer",
    type: "user",
    name: "Owner",
    owner_user_id: "owner-1"
  });
  await insertExtension(db, {
    id: "Existing-Ext",
    developer_id: "owner-developer",
    name: "Existing"
  });
}

async function createExtension(
  user: string,
  overrides?: { extensionId?: string; name?: string }
) {
  return post(
    "/extensions/v2/extensions",
    await authHeaders(user),
    sampleCreate(overrides)
  );
}

describe("Extensions API v2 writes", () => {
  describe("POST /extensions", () => {
    it("requires auth", async () => {
      const res = await post(
        "/extensions/v2/extensions",
        { "Content-Type": "application/json" },
        sampleCreate()
      );
      expect(res.status).toBe(401);
    });

    it("rejects an invalid body", async () => {
      const res = await post(
        "/extensions/v2/extensions",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(422);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects the reserved extension id mine", async () => {
      await seedDeveloper("new-developer", "user-1");
      const res = await createExtension("user-1", { extensionId: "mine" });

      expect(res.status).toBe(422);
      expect(await countRevisions(db)).toBe(0);
    });

    it("refuses a caller with no developer profile to publish under", async () => {
      const res = await createExtension("user-1");

      expect(res.status).toBe(403);
      expect(await countRevisions(db)).toBe(0);
    });

    it("creates the extension record and its first pending revision", async () => {
      await seedDeveloper("new-developer", "user-1");
      const res = await createExtension("user-1");

      expect(res.status).toBe(201);
      const data = (await res.json()) as {
        result: { id: string; revision_id: string; status: string };
      };
      expect(data.result).toMatchObject({ id: "new-ext", status: "pending" });

      // Holds its id immediately, but stays unpublished until a moderator
      // approves.
      const stored = await getExtension(db, "new-ext");
      expect(stored).toMatchObject({
        developer_id: "new-developer",
        published_at: null,
        published_revision_id: null,
        name: null
      });

      const revision = await getRevision(db, data.result.revision_id);
      expect(revision).toMatchObject({
        extension_id: "new-ext",
        submitted_by: "user-1",
        status: "pending"
      });
      // The id is the extension's identity, not something a revision proposes.
      expect(JSON.parse(revision!.content)).not.toHaveProperty("id");
    });

    it("leaves no extension behind when the revision cannot be written", async () => {
      await seedDeveloper("new-developer", "user-1");
      expect((await createExtension("user-1")).status).toBe(201);

      // Same id, different owner: the insert is swallowed by ON CONFLICT and
      // the batch's changes()-gate must stop the revision too.
      await seedDeveloper("other-developer", "user-2");
      const res = await createExtension("user-2");

      expect(res.status).toBe(409);
      expect(await countRevisions(db)).toBe(1);
    });

    it("rejects an id already taken by a published extension", async () => {
      await seedOwnedExtension();
      const res = await createExtension("owner-1", {
        extensionId: "existing-ext"
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "CONFLICT" }
      });
    });

    it("rejects an id that differs from an existing one only in case", async () => {
      await seedMixedCaseExtension();
      const res = await createExtension("owner-1", {
        extensionId: "existing-ext"
      });

      expect(res.status).toBe(409);
      expect(await countExtensions(db)).toBe(1);
    });

    it("bounds content size, unknown fields, and the number of releases", async () => {
      await seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      const body = sampleCreate();

      // The readme's own bound, which fires at ~100 KB. Asserted by path so it
      // cannot quietly become the reason some other case passes.
      const oversizedReadme = await post("/extensions/v2/extensions", headers, {
        ...body,
        readme: "x".repeat(100_001)
      });
      expect(oversizedReadme.status).toBe(422);
      const oversizedReadmeBody = (await oversizedReadme.json()) as {
        error: { details: Array<{ code: string; path: PropertyKey[] }> };
      };
      expect(oversizedReadmeBody.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "too_big", path: ["readme"] })
        ])
      );

      const unknownField = await post("/extensions/v2/extensions", headers, {
        ...body,
        padding: "x"
      });
      expect(unknownField.status).toBe(422);
      const unknownBody = (await unknownField.json()) as {
        error: { details: Array<{ code: string; path: PropertyKey[] }> };
      };
      expect(unknownBody.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "unrecognized_keys", path: [] })
        ])
      );

      const unknownReleaseField = await post(
        "/extensions/v2/extensions",
        headers,
        { ...body, releases: [{ ...body.releases[0], padding: "x" }] }
      );
      expect(unknownReleaseField.status).toBe(422);
      const unknownReleaseBody = (await unknownReleaseField.json()) as {
        error: { details: Array<{ code: string; path: PropertyKey[] }> };
      };
      expect(unknownReleaseBody.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            path: ["releases", 0]
          })
        ])
      );

      const tooManyReleases = await post("/extensions/v2/extensions", headers, {
        ...body,
        releases: Array.from({ length: 101 }, () => body.releases[0])
      });
      expect(tooManyReleases.status).toBe(422);
    });

    // The 256 KiB guard is a separate limit from the per-field bounds, and
    // nothing else reaches it: the largest single field is the readme at
    // ~100 KB. Only content that is valid field-by-field yet large in
    // aggregate exercises it - 100 releases (the maximum) carrying
    // maximum-length URLs comes to roughly 440 KB.
    it("rejects content that is within every field bound but over 256 KiB", async () => {
      await seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      const longUrl = `https://example.com/${"x".repeat(2028)}`;
      expect(longUrl).toHaveLength(2048);

      const releases = Array.from({ length: 100 }, (_unused, index) => ({
        tag: `1.0.${index}`.padEnd(100, "0"),
        date: "2026-01-01T00:00:00Z",
        download_url: longUrl,
        changelog_url: longUrl,
        min_fossbilling_version: "0.6"
      }));
      const body = { ...sampleCreate(), releases };
      expect(
        new TextEncoder().encode(JSON.stringify(body)).byteLength
      ).toBeGreaterThan(256 * 1024);

      const created = await post("/extensions/v2/extensions", headers, body);
      expect(created.status).toBe(422);
      const detail = (await created.json()) as {
        error: { details: Array<{ code: string; message: string }> };
      };
      // Specifically the size guard, not some field constraint tripping first.
      expect(detail.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "Extension content must not exceed 256 KiB"
          })
        ])
      );
      expect(await countExtensions(db)).toBe(0);

      // The edit body carries the same guard.
      await seedOwnedExtension();
      const { id: _id, ...content } = body;
      const edited = await put(
        "/extensions/v2/extensions/existing-ext",
        await authHeaders("owner-1"),
        content
      );
      expect(edited.status).toBe(422);
      expect(await countRevisions(db)).toBe(0);
    });

    it("preserves compatibility with stored slug ids over 100 characters", async () => {
      await seedDeveloper("d".repeat(120), "user-1");
      const res = await createExtension("user-1", {
        extensionId: "e".repeat(120)
      });
      expect(res.status).toBe(201);
    });

    it("caps each user's unreviewed backlog", async () => {
      await seedDeveloper("new-developer", "user-1");
      for (let index = 0; index < 10; index++) {
        const result = await createExtension("user-1", {
          extensionId: `new-ext-${index}`
        });
        expect(result.status).toBe(201);
      }

      const overLimit = await createExtension("user-1", {
        extensionId: "over-limit"
      });
      expect(overLimit.status).toBe(409);
      expect(await countRevisions(db)).toBe(10);
      expect(await getExtension(db, "over-limit")).toBeNull();
    });
  });

  describe("PUT /extensions/{id}", () => {
    it("requires auth", async () => {
      const res = await put(
        "/extensions/v2/extensions/existing-ext",
        { "Content-Type": "application/json" },
        sampleContent()
      );
      expect(res.status).toBe(401);
    });

    it("reports an unknown extension as 404, not 403", async () => {
      const res = await put(
        "/extensions/v2/extensions/no-such-ext",
        await authHeaders("user-1"),
        sampleContent()
      );
      expect(res.status).toBe(404);
    });

    it("rejects an edit from someone who does not own the extension", async () => {
      await seedOwnedExtension();
      const res = await put(
        "/extensions/v2/extensions/existing-ext",
        await authHeaders("intruder"),
        sampleContent()
      );

      expect(res.status).toBe(403);
      expect(await countRevisions(db)).toBe(0);
    });

    it("accepts an edit from the owner without changing the published content", async () => {
      await seedOwnedExtension();
      const res = await put(
        "/extensions/v2/extensions/existing-ext",
        await authHeaders("owner-1"),
        sampleContent({ name: "Renamed" })
      );

      expect(res.status).toBe(202);
      const [revision] = await listRevisions(db);
      expect(revision).toMatchObject({
        extension_id: "existing-ext",
        status: "pending"
      });
      expect(JSON.parse(revision.content).name).toBe("Renamed");

      // Still the pre-edit content: an edit is a proposal, not a write.
      const stored = await getExtension(db, "existing-ext");
      expect(stored?.name).toBe("Existing");
      expect(stored?.published_at).not.toBeNull();
    });

    it("allows only one unreviewed edit per extension", async () => {
      await seedOwnedExtension();
      const headers = await authHeaders("owner-1");
      expect(
        (
          await put(
            "/extensions/v2/extensions/existing-ext",
            headers,
            sampleContent()
          )
        ).status
      ).toBe(202);

      const second = await put(
        "/extensions/v2/extensions/existing-ext",
        headers,
        sampleContent({ name: "Again" })
      );
      expect(second.status).toBe(409);
      expect(await countRevisions(db)).toBe(1);
    });

    it("cannot rename an extension: the id comes from the path", async () => {
      await seedOwnedExtension();
      const res = await put(
        "/extensions/v2/extensions/existing-ext",
        await authHeaders("owner-1"),
        { ...sampleContent(), id: "renamed" }
      );

      expect(res.status).toBe(422);
      expect(await getExtension(db, "renamed")).toBeNull();
    });
  });

  // Every read resolves an extension id case-insensitively, so the writes have
  // to agree: otherwise a legacy mixed-case extension is visible but not
  // editable, and its own revision list comes back empty.
  // requireActiveAuth() can only reject before a write. Each guarded statement
  // repeats the check, so each blocked-write diagnosis has to recognise it —
  // otherwise a deactivated caller is told their write conflicted.
  describe("account deactivated mid-request", () => {
    function deactivateBefore(match: string, userId: string) {
      let done = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!done && sql.includes(match)) {
          done = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), userId)
            .run();
        }
      });
    }

    it("reports 403 from create, not a conflict", async () => {
      await seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      deactivateBefore("INSERT INTO extensions", "user-1");

      const res = await post(
        "/extensions/v2/extensions",
        headers,
        sampleCreate()
      );

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "ACCOUNT_INACTIVE" }
      });
      expect(await getExtension(db, "new-ext")).toBeNull();
    });

    it("reports 403 from an edit, not the pending-limit conflict", async () => {
      await seedOwnedExtension();
      const headers = await authHeaders("owner-1");
      // The propose insert is the first statement of the PUT to touch this table.
      deactivateBefore("extension_revisions", "owner-1");

      const res = await put(
        "/extensions/v2/extensions/existing-ext",
        headers,
        sampleContent()
      );

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "ACCOUNT_INACTIVE" }
      });
      expect(await countRevisions(db)).toBe(0);
    });
  });

  describe("mixed-case legacy ids", () => {
    it("accepts an edit addressed in lower case", async () => {
      await seedMixedCaseExtension();
      const res = await put(
        "/extensions/v2/extensions/existing-ext",
        await authHeaders("owner-1"),
        sampleContent({ name: "Renamed" })
      );

      expect(res.status).toBe(202);
      // The revision must hang off the stored spelling, not the requested one.
      const [revision] = await listRevisions(db);
      expect(revision.extension_id).toBe("Existing-Ext");
    });

    it("lists revisions addressed in lower case", async () => {
      await seedMixedCaseExtension();
      await put(
        "/extensions/v2/extensions/existing-ext",
        await authHeaders("owner-1"),
        sampleContent()
      );

      const res = await get(
        "/extensions/v2/extensions/existing-ext/revisions",
        await authHeaders("owner-1")
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: unknown[] };
      expect(data.result).toHaveLength(1);
    });

    // One walk over every path that addresses an extension by id, each asked
    // in a case that does not match the stored spelling. The finding was that
    // reads and writes disagreed, so the guard has to cover all of them at
    // once rather than one endpoint at a time.
    it("resolves every id-addressed path regardless of case", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedMixedCaseExtension();
      const owner = await authHeaders("owner-1");
      const mod = await authHeaders("mod-1");

      expect(
        (await get("/extensions/v2/extensions/existing-EXT", {})).status
      ).toBe(200);
      expect(
        (await get("/extensions/v2/extensions/mine/EXISTING-ext", owner)).status
      ).toBe(200);

      const edit = await put(
        "/extensions/v2/extensions/existing-ext",
        owner,
        sampleContent({ name: "Renamed" })
      );
      expect(edit.status).toBe(202);
      const first = (await edit.json()) as { result: { revision_id: string } };

      expect(
        (await get("/extensions/v2/extensions/EXISTING-EXT/revisions", owner))
          .status
      ).toBe(200);
      expect(
        (
          await post(
            `/extensions/v2/extensions/existing-EXT/revisions/${first.result.revision_id}/reject`,
            mod,
            { review_note: "no" }
          )
        ).status
      ).toBe(200);

      const retry = await put(
        "/extensions/v2/extensions/EXISTING-ext",
        owner,
        sampleContent({ name: "Second" })
      );
      const second = (await retry.json()) as {
        result: { revision_id: string };
      };
      expect(
        (
          await post(
            `/extensions/v2/extensions/existing-ext/revisions/${second.result.revision_id}/approve`,
            mod,
            {}
          )
        ).status
      ).toBe(200);

      // Published through the stored spelling, not a second lowercase row.
      expect(await countExtensions(db)).toBe(1);
      expect(await getExtension(db, "Existing-Ext")).toMatchObject({
        name: "Second"
      });
    });

    it("withdraws an unpublished extension addressed in the other case", async () => {
      await seedDeveloper("new-developer", "user-1");
      await createExtension("user-1", { extensionId: "new-ext" });

      const res = await del(
        "/extensions/v2/extensions/NEW-EXT",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      expect(await getExtension(db, "new-ext")).toBeNull();
    });
  });

  describe("DELETE /extensions/{id}", () => {
    it("withdraws an unpublished extension and releases its id", async () => {
      await seedDeveloper("new-developer", "user-1");
      expect((await createExtension("user-1")).status).toBe(201);

      const res = await del(
        "/extensions/v2/extensions/new-ext",
        await authHeaders("user-1")
      );

      expect(res.status).toBe(200);
      expect(await getExtension(db, "new-ext")).toBeNull();
      // The revision cascades with it - there is nothing left to review.
      expect(await countRevisions(db)).toBe(0);

      expect((await createExtension("user-1")).status).toBe(201);
    });

    it("refuses to withdraw a published extension", async () => {
      await seedOwnedExtension();
      const res = await del(
        "/extensions/v2/extensions/existing-ext",
        await authHeaders("owner-1")
      );

      expect(res.status).toBe(409);
      expect(await getExtension(db, "existing-ext")).not.toBeNull();
    });

    // requireActiveAuth() can only reject before the write; a deletion landing
    // between it and the DELETE has to be caught by the statement itself.
    it("refuses to withdraw once the account is deactivated mid-request", async () => {
      await seedDeveloper("new-developer", "user-1");
      await createExtension("user-1");
      const headers = await authHeaders("user-1");

      let tombstoned = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!tombstoned && sql.includes('DELETE FROM "extensions"')) {
          tombstoned = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), "user-1")
            .run();
        }
      });

      const res = await del("/extensions/v2/extensions/new-ext", headers);

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "ACCOUNT_INACTIVE" }
      });
      expect(await getExtension(db, "new-ext")).not.toBeNull();
    });

    // The inactive check has to run before the published and ownership
    // branches, or a deactivated caller is told their extension is published
    // (409) instead of that their account is gone. The deactivation has to
    // land mid-request: done beforehand, requireActiveAuth() answers first and
    // the diagnosis never runs.
    it("reports a deactivated account ahead of any other reason", async () => {
      await seedOwnedExtension();
      const headers = await authHeaders("owner-1");

      let done = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!done && sql.toLowerCase().includes("delete from")) {
          done = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), "owner-1")
            .run();
        }
      });

      // Published *and* deactivated: the 409 branch would otherwise win.
      const res = await del("/extensions/v2/extensions/existing-ext", headers);

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "ACCOUNT_INACTIVE" }
      });
      expect(await getExtension(db, "existing-ext")).not.toBeNull();
    });

    it("refuses to withdraw someone else's extension", async () => {
      await seedDeveloper("new-developer", "user-1");
      await createExtension("user-1");

      const res = await del(
        "/extensions/v2/extensions/new-ext",
        await authHeaders("intruder")
      );

      expect(res.status).toBe(403);
      expect(await getExtension(db, "new-ext")).not.toBeNull();
    });
  });

  describe("GET /extensions/mine", () => {
    it("returns published and unpublished extensions in one page", async () => {
      await seedOwnedExtension();
      const headers = await authHeaders("owner-1");
      expect(
        (
          await post("/extensions/v2/extensions", headers, {
            ...sampleCreate({ extensionId: "draft-ext" })
          })
        ).status
      ).toBe(201);

      const res = await get("/extensions/v2/extensions/mine", headers);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: Array<{
          id: string;
          published: { name: string } | null;
          pending_revision: { id: string } | null;
          last_review: unknown;
        }>;
      };

      expect(data.result.map((item) => item.id)).toEqual([
        "draft-ext",
        "existing-ext"
      ]);
      const [draft, published] = data.result;
      expect(draft.published).toBeNull();
      expect(draft.pending_revision).not.toBeNull();
      expect(draft.last_review).toBeNull();
      expect(published.published).toMatchObject({ name: "Existing" });
      expect(published.pending_revision).toBeNull();
    });

    it("shows a published extension and its unreviewed edit together", async () => {
      await seedOwnedExtension();
      const headers = await authHeaders("owner-1");
      await put(
        "/extensions/v2/extensions/existing-ext",
        headers,
        sampleContent({ name: "Renamed" })
      );

      const res = await get("/extensions/v2/extensions/mine", headers);
      const data = (await res.json()) as {
        result: Array<{
          published: { name: string } | null;
          pending_revision: { id: string } | null;
        }>;
      };
      expect(data.result[0].published).toMatchObject({ name: "Existing" });
      expect(data.result[0].pending_revision).not.toBeNull();
    });

    // Both of these are states the README's mapping table now documents, and
    // both were reachable before it did.
    it("reports a live extension adopted from the pre-v2 catalogue", async () => {
      await seedOwnedExtension();

      const res = await get(
        "/extensions/v2/extensions/mine",
        await authHeaders("owner-1")
      );
      const data = (await res.json()) as {
        result: Array<{
          published: unknown;
          pending_revision: unknown;
          last_review: unknown;
        }>;
      };
      // Published with no review history at all: migration 0021 published
      // every extension that already existed, and those have no revisions.
      expect(data.result[0].published).not.toBeNull();
      expect(data.result[0].pending_revision).toBeNull();
      expect(data.result[0].last_review).toBeNull();
    });

    it("reports a rejected extension that has already been resubmitted", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const created = await createExtension("user-1");
      const { result } = (await created.json()) as {
        result: { revision_id: string };
      };
      await post(
        `/extensions/v2/extensions/new-ext/revisions/${result.revision_id}/reject`,
        await authHeaders("mod-1"),
        { review_note: "no" }
      );
      await put(
        "/extensions/v2/extensions/new-ext",
        await authHeaders("user-1"),
        sampleContent({ name: "Fixed" })
      );

      const res = await get(
        "/extensions/v2/extensions/mine",
        await authHeaders("user-1")
      );
      await expect(res.json()).resolves.toMatchObject({
        result: [
          {
            published: null,
            pending_revision: { id: expect.any(String) },
            last_review: { status: "rejected" }
          }
        ]
      });
    });

    it("excludes other developers' extensions", async () => {
      await seedOwnedExtension();
      await seedDeveloper("other-developer", "user-2");
      await createExtension("user-2", { extensionId: "other-ext" });

      const res = await get(
        "/extensions/v2/extensions/mine",
        await authHeaders("owner-1")
      );
      const data = (await res.json()) as { result: Array<{ id: string }> };
      expect(data.result.map((item) => item.id)).toEqual(["existing-ext"]);
    });

    // extensions.type is NULL until a first approval, so filtering the column
    // alone would hide an owner's own drafts from them.
    it("filters by type across published, pending and rejected states", async () => {
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");

      // Published.
      const live = await createExtension("user-1", { extensionId: "live-ext" });
      const liveIds = (await live.json()) as {
        result: { revision_id: string };
      };
      await post(
        `/extensions/v2/extensions/live-ext/revisions/${liveIds.result.revision_id}/approve`,
        await authHeaders("mod-1"),
        {}
      );

      // Never reviewed.
      await createExtension("user-1", { extensionId: "draft-ext" });

      // Reviewed and rejected: no pending revision left to read a type from.
      const rejected = await createExtension("user-1", {
        extensionId: "rejected-ext"
      });
      const rejectedIds = (await rejected.json()) as {
        result: { revision_id: string };
      };
      await post(
        `/extensions/v2/extensions/rejected-ext/revisions/${rejectedIds.result.revision_id}/reject`,
        await authHeaders("mod-1"),
        { review_note: "no" }
      );

      const res = await get("/extensions/v2/extensions/mine?type=mod", headers);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: Array<{ id: string }> };
      expect(data.result.map((item) => item.id)).toEqual([
        "draft-ext",
        "live-ext",
        "rejected-ext"
      ]);

      const other = await get(
        "/extensions/v2/extensions/mine?type=theme",
        headers
      );
      await expect(other.json()).resolves.toMatchObject({ result: [] });
    });

    it("requires auth", async () => {
      const res = await get("/extensions/v2/extensions/mine", {});
      expect(res.status).toBe(401);
    });

    it("identifies invalid cursors", async () => {
      const res = await get(
        "/extensions/v2/extensions/mine?cursor=not-a-cursor",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "INVALID_CURSOR" }
      });
    });

    it("paginates deterministically with an opaque cursor", async () => {
      await seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      for (const extensionId of ["page-a", "page-b", "page-c"]) {
        expect((await createExtension("user-1", { extensionId })).status).toBe(
          201
        );
      }

      const first = await get(
        "/extensions/v2/extensions/mine?limit=2",
        headers
      );
      const firstBody = (await first.json()) as {
        result: Array<{ id: string }>;
        pagination: { has_more: boolean; next_cursor: string };
      };
      expect(firstBody.result.map((item) => item.id)).toEqual([
        "page-a",
        "page-b"
      ]);
      expect(firstBody.pagination.has_more).toBe(true);

      const second = await get(
        `/extensions/v2/extensions/mine?limit=2&cursor=${encodeURIComponent(firstBody.pagination.next_cursor)}`,
        headers
      );
      const secondBody = (await second.json()) as {
        result: Array<{ id: string }>;
        pagination: { has_more: boolean; next_cursor: null };
      };
      expect(secondBody.result.map((item) => item.id)).toEqual(["page-c"]);
      expect(secondBody.pagination).toEqual({
        has_more: false,
        next_cursor: null
      });
    });
  });

  describe("GET /extensions/mine/{id}", () => {
    it("returns an unpublished extension with its pending content", async () => {
      await seedDeveloper("new-developer", "user-1");
      await createExtension("user-1");

      const res = await get(
        "/extensions/v2/extensions/mine/new-ext",
        await authHeaders("user-1")
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: {
          published: unknown;
          pending_revision: { content: { name: string } };
        };
      };
      expect(data.result.published).toBeNull();
      expect(data.result.pending_revision.content.name).toBe("New Extension");
    });

    // v1 constrained extensions.releases to NOT NULL and nothing more, so a
    // row adopted by migration 0021 can be published with none. The owner view
    // has to describe that rather than a shape the data cannot take. Hono does
    // not validate responses, so only parsing the body back through the
    // advertised schema catches the disagreement.
    it("serves an adopted extension with no releases against its own schema", async () => {
      await insertDeveloper(db, {
        id: "owner-developer",
        type: "user",
        name: "Owner",
        owner_user_id: "owner-1"
      });
      await insertExtension(db, {
        id: "adopted-ext",
        developer_id: "owner-developer",
        name: "Adopted",
        releases: "[]"
      });

      const res = await get(
        "/extensions/v2/extensions/mine/adopted-ext",
        await authHeaders("owner-1")
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { published: { releases: unknown[] } };
      };
      expect(body.result.published.releases).toEqual([]);
      expect(OwnedExtensionSchema.safeParse(body.result).success).toBe(true);
    });

    it("refuses to show someone else's extension", async () => {
      await seedOwnedExtension();
      const res = await get(
        "/extensions/v2/extensions/mine/existing-ext",
        await authHeaders("intruder")
      );
      expect(res.status).toBe(403);
    });

    it("404s an unknown id", async () => {
      const res = await get(
        "/extensions/v2/extensions/mine/no-such-ext",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(404);
    });

    // "mine" is a reserved extension id, so /extensions/mine/revisions can
    // only be the owner detail route - see the registration order in index.ts.
    it("resolves /extensions/mine/revisions as an owner detail read", async () => {
      const res = await get(
        "/extensions/v2/extensions/mine/revisions",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /extensions/{id}/revisions", () => {
    it("lists an extension's revisions newest first", async () => {
      await seedDeveloper("new-developer", "user-1");
      await createExtension("user-1");
      const headers = await authHeaders("user-1");

      const res = await get(
        "/extensions/v2/extensions/new-ext/revisions",
        headers
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: Array<{ extension_id: string; status: string }>;
      };
      expect(data.result).toHaveLength(1);
      expect(data.result[0]).toMatchObject({
        extension_id: "new-ext",
        status: "pending"
      });
    });

    it("refuses a caller who neither owns the extension nor moderates", async () => {
      await seedOwnedExtension();
      const res = await get(
        "/extensions/v2/extensions/existing-ext/revisions",
        await authHeaders("intruder")
      );
      expect(res.status).toBe(403);
    });
  });
});
