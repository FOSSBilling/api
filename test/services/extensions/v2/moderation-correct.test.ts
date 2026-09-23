import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { wrapD1WithHook } from "./db-interceptor";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  post,
  put,
  sampleContent,
  sampleCreate,
  seedDeveloper
} from "./harness";
import {
  insertUser,
  insertExtension,
  insertUnpublishedExtension,
  countRevisions,
  getDeveloper,
  getExtension,
  getRevision,
  listRevisions
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

const PATH = "/extensions/v2/extensions/live-ext/moderator-correct";

function correctBody(overrides?: Record<string, unknown>) {
  return {
    ...sampleContent(),
    correction_note: "Fix truncated readme",
    ...overrides
  };
}

async function seedPublished(): Promise<void> {
  await insertUser(db, { id: "mod-1", is_moderator: 1 });
  await seedDeveloper("new-developer", "user-1");
  await insertExtension(db, {
    id: "live-ext",
    developer_id: "new-developer",
    readme: "old readme"
  });
}

describe("POST /extensions/{id}/moderator-correct (api#251)", () => {
  it("requires auth", async () => {
    const res = await post(
      PATH,
      { "Content-Type": "application/json" },
      correctBody()
    );
    expect(res.status).toBe(401);
  });

  it("blocks non-moderators", async () => {
    await seedPublished();
    const res = await post(PATH, await authHeaders("user-1"), correctBody());
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" }
    });
  });

  it("reports 403 when the moderator is deactivated mid-correct", async () => {
    await seedPublished();
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

    const res = await post(PATH, headers, correctBody());
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "ACCOUNT_INACTIVE" }
    });
    expect((await getExtension(db, "live-ext"))?.readme).toBe("old readme");
    // The guarded INSERT never ran, so no orphan revision row is left behind.
    expect(await countRevisions(db)).toBe(0);
  });

  it("404s for an unknown extension", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    const res = await post(
      "/extensions/v2/extensions/no-such-extension/moderator-correct",
      await authHeaders("mod-1"),
      correctBody()
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" }
    });
  });

  it("409s for an unpublished extension", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await seedDeveloper("new-developer", "user-1");
    await insertUnpublishedExtension(db, {
      id: "draft-ext",
      developer_id: "new-developer"
    });
    const res = await post(
      "/extensions/v2/extensions/draft-ext/moderator-correct",
      await authHeaders("mod-1"),
      correctBody()
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "CONFLICT" }
    });
    expect(await countRevisions(db)).toBe(0);
  });

  it("409s for a delisted extension", async () => {
    await seedPublished();
    await db
      .prepare(
        "UPDATE extensions SET delisted_at = ?, delist_reason = ? WHERE id = ?"
      )
      .bind(new Date().toISOString(), "cause", "live-ext")
      .run();
    const res = await post(PATH, await authHeaders("mod-1"), correctBody());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "CONFLICT" }
    });
    expect(await countRevisions(db)).toBe(0);
  });

  it("409s when a pending revision exists", async () => {
    await seedPublished();
    const edit = await put(
      "/extensions/v2/extensions/live-ext",
      await authHeaders("user-1"),
      sampleContent({ name: "Author Edit" })
    );
    expect(edit.status).toBe(202);

    const res = await post(PATH, await authHeaders("mod-1"), correctBody());
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "CONFLICT" }
    });
    // Neither the live content nor the pending edit moves.
    expect((await getExtension(db, "live-ext"))?.readme).toBe("old readme");
    // Only the author's pending revision exists: the failed correction added
    // no row of its own.
    expect(await countRevisions(db)).toBe(1);
  });

  it("422s on a blank correction_note", async () => {
    await seedPublished();
    const res = await post(
      PATH,
      await authHeaders("mod-1"),
      correctBody({ correction_note: "   " })
    );
    expect(res.status).toBe(422);
  });

  it("422s on an overlong correction_note", async () => {
    await seedPublished();
    const res = await post(
      PATH,
      await authHeaders("mod-1"),
      correctBody({ correction_note: "x".repeat(2001) })
    );
    expect(res.status).toBe(422);
    expect(await countRevisions(db)).toBe(0);
  });

  it("422s on invalid content", async () => {
    await seedPublished();
    const res = await post(
      PATH,
      await authHeaders("mod-1"),
      correctBody({ readme: "" })
    );
    expect(res.status).toBe(422);
  });

  it("corrects live content and records an approved moderator revision", async () => {
    await seedPublished();
    const before = await getExtension(db, "live-ext");
    expect(before?.published_at).not.toBeNull();

    const res = await post(
      PATH,
      await authHeaders("mod-1"),
      correctBody({ name: "Fixed Extension", readme: "# Fixed" })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { id: string; revision_id: string; status: string };
    };
    expect(body.result).toMatchObject({ id: "live-ext", status: "approved" });
    expect(typeof body.result.revision_id).toBe("string");
    // No notification envelope on this route (api#251: history only).
    expect("notified" in body.result).toBe(false);

    const after = await getExtension(db, "live-ext");
    expect(after?.name).toBe("Fixed Extension");
    expect(after?.readme).toBe("# Fixed");
    expect(after?.published_at).toBe(before?.published_at);
    expect(after?.published_revision_id).toBe(body.result.revision_id);

    const revision = await getRevision(db, body.result.revision_id);
    expect(revision).toMatchObject({
      extension_id: "live-ext",
      status: "approved",
      submitted_by: "mod-1",
      reviewer_id: "mod-1",
      review_note: "Fix truncated readme"
    });
    expect(JSON.parse(revision!.content)).toMatchObject({
      name: "Fixed Extension",
      readme: "# Fixed"
    });

    // Ownership is untouched: developer, owner, and epoch survive.
    expect(await getDeveloper(db, "new-developer")).toMatchObject({
      id: "new-developer",
      owner_user_id: "user-1",
      ownership_epoch: 1
    });
    expect(
      (await listRevisions(db)).filter((r) => r.status === "pending")
    ).toHaveLength(0);
  });

  it("matches ids case-insensitively and returns the canonical id", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await seedDeveloper("new-developer", "user-1");
    await insertExtension(db, {
      id: "LIVE-ext",
      developer_id: "new-developer"
    });
    const res = await post(
      "/extensions/v2/extensions/live-EXT/moderator-correct",
      await authHeaders("mod-1"),
      correctBody()
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      result: { id: "LIVE-ext", status: "approved" }
    });
  });

  it("creates through the full owner flow then corrects, preserving history", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await seedDeveloper("new-developer", "user-1");
    const created = await post(
      "/extensions/v2/extensions",
      await authHeaders("user-1"),
      sampleCreate({ extensionId: "history-ext" })
    );
    expect(created.status).toBe(201);
    const { result: pending } = (await created.json()) as {
      result: { id: string; revision_id: string };
    };
    expect(
      (
        await post(
          `/extensions/v2/extensions/${pending.id}/revisions/${pending.revision_id}/approve?notify=false`,
          await authHeaders("mod-1"),
          {}
        )
      ).status
    ).toBe(200);

    const res = await post(
      "/extensions/v2/extensions/history-ext/moderator-correct",
      await authHeaders("mod-1"),
      { ...sampleContent(), readme: "# Corrected", correction_note: "typo" }
    );
    expect(res.status).toBe(200);

    // The owner's approval and the moderator's correction are both in
    // history as approved revisions.
    const revisions = await listRevisions(db);
    expect(
      revisions
        .filter((r) => r.extension_id === "history-ext")
        .map((r) => r.status)
        .sort()
    ).toEqual(["approved", "approved"]);
  });
});
