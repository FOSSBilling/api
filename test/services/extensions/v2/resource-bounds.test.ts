import { describe, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../../src/app";
import { getExtensionsDb } from "../../../../src/lib/db";
import {
  maintainExtensionResources,
  reportExtensionResources,
  inventoryExtensionRetention
} from "../../../../src/services/extensions/v2/db/resource-maintenance";
import {
  ExtensionListItemSchema,
  ExtensionUpdateSchema,
  OwnedExtensionListItemSchema
} from "../../../../src/services/extensions/v2/schemas/extensions";
import {
  MAX_ACCOUNT_BYTES,
  MAX_CONTENT_BYTES,
  MAX_RAW_BODY_BYTES,
  MAINTENANCE_BATCH_SIZE
} from "../../../../src/services/extensions/v2/resource-limits";
import { databaseError } from "../../../../src/services/extensions/v2/db/errors";
import { ExtensionsDatabase } from "../../../../src/services/extensions/v2/db/extensions";
import { wrapD1WithHook } from "./db-interceptor";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  seedDeveloper,
  sampleCreate,
  sampleContent,
  post,
  put,
  get
} from "./harness";
import {
  insertExtension,
  insertRevision,
  insertUser,
  countExtensions,
  countRevisions
} from "./db-fixtures";
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);
setupExtensionsV2Tests();

async function withdraw(id: string, user = "owner") {
  const ctx = createExecutionContext();
  const result = await app.request(
    `/extensions/v2/extensions/${id}`,
    { method: "DELETE", headers: await authHeaders(user) },
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return result;
}
async function create(id: string) {
  return post("/extensions/v2/extensions", await authHeaders("owner"), {
    ...sampleCreate(),
    id
  });
}
async function owned() {
  await seedDeveloper("developer", "owner");
  await insertExtension(db, { id: "live", developer_id: "developer" });
}
async function ageEvents(seconds = 120) {
  await db
    .prepare("UPDATE extension_write_events SET occurred_at=unixepoch()-?")
    .bind(seconds)
    .run();
}
async function insertHistory(id: string, status = "rejected") {
  await insertRevision(db, {
    id,
    extension_id: "live",
    developer_id: "developer",
    submitted_by: "owner",
    content: JSON.stringify(sampleContent()),
    status,
    created_at: "2000-01-01 00:00:00",
    reviewed_at: "2000-01-01 00:00:00"
  });
}

describe("Extension resource admission", () => {
  it("retires expired events with accepted writes across unrelated accounts", async () => {
    await owned();
    await db.batch(
      Array.from({ length: 120 }, (_, i) =>
        db
          .prepare(
            "INSERT INTO extension_write_events VALUES (?, ?, ?, unixepoch()-86401)"
          )
          .bind(`expired-${i}`, `other-${i}`, `dev-${i}`)
      )
    );
    await db
      .prepare(
        "INSERT INTO extension_write_events VALUES ('live-event','other','other',unixepoch()-120)"
      )
      .run();
    for (const id of ["one", "two", "three"]) {
      expect((await create(id)).status).toBe(201);
    }
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM extension_write_events WHERE occurred_at<=unixepoch()-86400"
        )
        .first("n")
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM extension_write_events WHERE id='live-event'"
        )
        .first("n")
    ).toBe(1);
  });
  // The retention index itself is pinned by db/schema.ts and the migration
  // snapshot; an EXPLAIN here would assert a hand-copied query that could
  // silently drift from the one in resource-maintenance.ts.
  it("keeps oversized published extensions visible as published cards", async () => {
    await owned();
    await db
      .prepare("UPDATE extensions SET readme=? WHERE id='live'")
      .bind("x".repeat(MAX_CONTENT_BYTES + 1))
      .run();
    const extensions = new ExtensionsDatabase(getExtensionsDb(db));
    const list = await extensions.listOwned({ developerId: "developer" });
    expect(list.error).toBeNull();
    expect(list.data?.items[0].published).not.toBeNull();
    expect(
      OwnedExtensionListItemSchema.safeParse(list.data?.items[0]).success
    ).toBe(true);
    expect((await extensions.getOwned("live")).error?.code).toBe(
      "CONTENT_UNAVAILABLE"
    );
  });

  it("prevents revision attribution changes from moving retained quota charges", async () => {
    await owned();
    await insertHistory("fixed-attribution");
    await insertUser(db, { id: "other" });
    await seedDeveloper("other-developer", "other");
    for (const column of [
      "submitted_by",
      "developer_id",
      "extension_id",
      "id"
    ]) {
      const value = column === "developer_id" ? "other-developer" : "other";
      await expect(
        db
          .prepare(
            `UPDATE extension_revisions SET ${column}=? WHERE id='fixed-attribution'`
          )
          .bind(value)
          .run()
      ).rejects.toThrow(/extension_resource_identity/);
    }
    expect(
      await db
        .prepare(
          "SELECT submitted_by,developer_id,extension_id,id FROM extension_revisions WHERE id='fixed-attribution'"
        )
        .first()
    ).toEqual({
      submitted_by: "owner",
      developer_id: "developer",
      extension_id: "live",
      id: "fixed-attribution"
    });
  });
  it("reconciles every charged published column against independent UTF-8 byte counts", async () => {
    await owned();
    const columns = [
      "type",
      "name",
      "description",
      "releases",
      "website",
      "license",
      "icon_url",
      "readme",
      "source",
      "version",
      "download_url"
    ];
    async function reconcile() {
      const rows = await db
        .prepare("SELECT * FROM extensions")
        .all<Record<string, string | null>>();
      const revisions = await db
        .prepare("SELECT content FROM extension_revisions")
        .all<{ content: string }>();
      const bytes =
        rows.results.reduce(
          (sum, row) =>
            sum +
            columns.reduce(
              (n, column) =>
                n + new TextEncoder().encode(row[column] ?? "").byteLength,
              0
            ),
          0
        ) +
        revisions.results.reduce(
          (sum, row) => sum + new TextEncoder().encode(row.content).byteLength,
          0
        );
      expect(
        await db
          .prepare(
            "SELECT bytes FROM extension_resource_usage WHERE scope='global'"
          )
          .first("bytes")
      ).toBe(bytes);
      for (const scope of ["account", "developer"])
        expect(
          await db
            .prepare(
              "SELECT COALESCE(SUM(bytes),0) AS n FROM extension_resource_usage WHERE scope=?"
            )
            .bind(scope)
            .first("n")
        ).toBe(bytes);
    }
    await reconcile();
    const content = sampleContent();
    const values = [
      content.type,
      "😀 Name",
      "Résumé 🧪",
      JSON.stringify(content.releases),
      "https://example.test/é",
      JSON.stringify({ name: "Lïcence" }),
      "https://example.test/😀.png",
      "読んでください",
      JSON.stringify({ type: "custom", repo: "café/😀" }),
      "1.0.0",
      "https://example.test/é.zip"
    ];
    for (let i = 0; i < columns.length; i++) {
      await db
        .prepare(`UPDATE extensions SET ${columns[i]}=? WHERE id='live'`)
        .bind(values[i])
        .run();
      await reconcile();
    }
    await insertHistory("charged-revision");
    await reconcile();
    await db
      .prepare(
        "UPDATE extension_revisions SET content=? WHERE id='charged-revision'"
      )
      .bind(JSON.stringify({ ...content, readme: "😀" }))
      .run();
    await reconcile();
    await db.prepare("DELETE FROM extensions WHERE id='live'").run();
    await reconcile();
  });
  it("preserves overflow status when stream cancellation rejects", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RAW_BODY_BYTES + 1));
      },
      cancel() {
        throw new Error("cancel failed");
      }
    });
    const response = await app.request(
      "/extensions/v2/extensions",
      { method: "POST", headers: await authHeaders("owner"), body: stream },
      env
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BODY_TOO_LARGE" }
    });
  });
  it("accepts a valid JSON body delivered in small chunks", async () => {
    await owned();
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...sampleCreate(), id: "chunked" })
    );
    let position = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (position === bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(position, position + 73));
        position = Math.min(position + 73, bytes.length);
      }
    });
    const response = await app.request(
      "/extensions/v2/extensions",
      { method: "POST", headers: await authHeaders("owner"), body: stream },
      env
    );
    expect(response.status).toBe(201);
  });

  it("bounds new extension IDs while preserving reads and edits of longer legacy IDs", async () => {
    await owned();
    const id = "e".repeat(201);
    expect((await create(id)).status).toBe(422);
    await insertExtension(db, { id, developer_id: "developer" });
    expect((await get(`/extensions/v2/extensions/${id}`, {})).status).toBe(200);
    expect(
      (
        await put(
          `/extensions/v2/extensions/${id}`,
          await authHeaders("owner"),
          sampleContent()
        )
      ).status
    ).toBe(202);
  });
  it("logs safe backend diagnostics without SQL or submitted content", () => {
    const error = Object.assign(
      new Error("SQLITE_BUSY: SELECT secret_content FROM private_table"),
      { code: "SQLITE_BUSY", name: "SqliteError" }
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      databaseError(
        "create",
        new Error("INSERT submitted payload", { cause: error })
      );
      expect(log).toHaveBeenCalledOnce();
      // The redaction property is the contract (exception messages can
      // carry SQL and submitted content); the log entry must carry only
      // the classified metadata.
      const entry = JSON.stringify(log.mock.calls[0][0]);
      expect(entry).toContain("SqliteError");
      expect(entry).toContain("SQLITE_BUSY");
      expect(entry).not.toMatch(
        /SELECT|INSERT|secret_content|submitted payload/
      );
    } finally {
      log.mockRestore();
    }
  });
  it("counts actual streamed bytes, cancels at overflow and ignores false length hints", async () => {
    let canceled = false;
    const headers = await authHeaders("owner");
    headers["Content-Length"] = "1";
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_RAW_BODY_BYTES + 1));
      },
      cancel() {
        canceled = true;
      }
    });
    const res = await app.request(
      "/extensions/v2/extensions",
      { method: "POST", headers, body: stream },
      env
    );
    expect(res.status).toBe(413);
    expect(canceled).toBe(true);
    expect(await countExtensions(db)).toBe(0);
  });
  it("accepts the exact raw-byte cap and rejects one byte more without Content-Length", async () => {
    await seedDeveloper("developer", "owner");
    const body = JSON.stringify({ ...sampleCreate(), id: "exact" });
    const padded =
      body +
      " ".repeat(
        MAX_RAW_BODY_BYTES - new TextEncoder().encode(body).byteLength
      );
    const headers = await authHeaders("owner");
    expect(
      (
        await app.request(
          "/extensions/v2/extensions",
          { method: "POST", headers, body: padded },
          env
        )
      ).status
    ).toBe(201);
    expect(
      (
        await app.request(
          "/extensions/v2/extensions",
          { method: "POST", headers, body: padded + " " },
          env
        )
      ).status
    ).toBe(413);
  });
  it("bounds raw moderator corrections and rejected unknown-field padding", async () => {
    for (const path of [
      "/extensions/v2/extensions",
      "/extensions/v2/extensions/live/moderator-correct"
    ]) {
      const response = await app.request(
        path,
        {
          method: "POST",
          headers: await authHeaders("owner"),
          body: JSON.stringify({ padding: "x".repeat(MAX_RAW_BODY_BYTES) })
        },
        env
      );
      expect(response.status).toBe(413);
    }
  });
  it("enforces the exact serialized content bound, including escaping", () => {
    const content = { ...sampleContent(), readme: "" };
    const base = new TextEncoder().encode(JSON.stringify(content)).byteLength;
    const remaining = MAX_CONTENT_BYTES - base;
    content.readme =
      "\0".repeat(Math.floor(remaining / 6)) + "x".repeat(remaining % 6);
    expect(new TextEncoder().encode(JSON.stringify(content)).byteLength).toBe(
      MAX_CONTENT_BYTES
    );
    expect(ExtensionUpdateSchema.safeParse(content).success).toBe(true);
    expect(
      ExtensionUpdateSchema.safeParse({
        ...content,
        readme: content.readme + "x"
      }).success
    ).toBe(false);
  });
  it("paces authenticated attempts before validation and fails closed when pacing is unavailable", async () => {
    await seedDeveloper("developer", "owner");
    env.EXTENSION_WRITE_RATE_LIMITER = {
      limit: async ({ key }) => ({ success: !key.startsWith("account:") })
    };
    const res = await post(
      "/extensions/v2/extensions",
      await authHeaders("owner"),
      { invalid: true }
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    env.EXTENSION_WRITE_RATE_LIMITER = {
      limit: async () => {
        throw new Error("unavailable");
      }
    };
    expect((await create("unavailable")).status).toBe(503);
    expect(await countExtensions(db)).toBe(0);
  });
  it.each(["create", "edit", "correct"] as const)(
    "fails closed with 503 when durable %s admission is unavailable",
    async (operation) => {
      await owned();
      await insertUser(db, { id: "mod", is_moderator: 1 });
      env.DB_EXTENSIONS = wrapD1WithHook(db, (query) => {
        if (
          /INSERT INTO (?:"?extension_revisions"?|"?extensions"?)/i.test(query)
        )
          throw new Error("D1 backend unavailable");
      });
      const res =
        operation === "create"
          ? await create("unavailable")
          : operation === "edit"
            ? await put(
                "/extensions/v2/extensions/live",
                await authHeaders("owner"),
                sampleContent()
              )
            : await post(
                "/extensions/v2/extensions/live/moderator-correct",
                await authHeaders("mod"),
                { ...sampleContent(), correction_note: "Fix" }
              );
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("60");
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "ADMISSION_UNAVAILABLE" }
      });
      expect(await countRevisions(db)).toBe(0);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM extension_write_events")
          .first("n")
      ).toBe(0);
      expect(await countExtensions(db)).toBe(1);
    }
  );
  it("atomically shares five accepted writes across concurrent creates and edits", async () => {
    await owned();
    const results = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => create(`concurrent-${i}`)),
      put(
        "/extensions/v2/extensions/live",
        await authHeaders("owner"),
        sampleContent()
      )
    ]);
    expect(
      results.filter((r) => r.status === 201 || r.status === 202)
    ).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    expect(await countRevisions(db)).toBe(5);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM extension_write_events")
        .first("n")
    ).toBe(5);
  });
  it("does not refund accepted allowance on withdrawal or profile/account lifecycle changes", async () => {
    await seedDeveloper("developer", "owner");
    for (let i = 0; i < 5; i++) {
      expect((await create(`churn-${i}`)).status).toBe(201);
      expect((await withdraw(`churn-${i}`)).status).toBe(200);
    }
    await db.prepare("DELETE FROM developers WHERE id='developer'").run();
    await seedDeveloper("replacement", "owner");
    await db
      .prepare("UPDATE users SET deleted_at=CURRENT_TIMESTAMP WHERE id='owner'")
      .run();
    await db.prepare("UPDATE users SET deleted_at=NULL WHERE id='owner'").run();
    expect((await create("churn-again")).status).toBe(429);
    expect(await countExtensions(db)).toBe(0);
    await ageEvents();
    expect((await create("after-window")).status).toBe(201);
  });
  it("enforces the rolling day budget without a whole-system write cap", async () => {
    await seedDeveloper("developer", "owner");
    await db.batch(
      Array.from({ length: 50 }, (_, i) =>
        db
          .prepare(
            "INSERT INTO extension_write_events VALUES (?, 'owner', 'developer', unixepoch()-120)"
          )
          .bind(`day-${i}`)
      )
    );
    const day = await create("day-limit");
    expect(day.status).toBe(429);
    expect(day.headers.get("Retry-After")).toBe("86400");
    await db.prepare("DELETE FROM extension_write_events").run();
    await db.batch(
      Array.from({ length: 300 }, (_, i) =>
        db
          .prepare(
            "INSERT INTO extension_write_events VALUES (?, ?, ?, unixepoch()-120)"
          )
          .bind(`global-${i}`, `user-${i}`, `developer-${i}`)
      )
    );
    const global = await create("global-limit");
    expect(global.status).toBe(201);
    expect(global.headers.has("Retry-After")).toBe(false);
    expect(await countExtensions(db)).toBe(1);
  });
  it("rolls back extensions and write charges when quota admission fails", async () => {
    await seedDeveloper("developer", "owner");
    expect((await create("first")).status).toBe(201);
    await ageEvents();
    await db
      .prepare(
        "UPDATE extension_resource_usage SET bytes=? WHERE scope='account' AND subject='owner'"
      )
      .bind(MAX_ACCOUNT_BYTES)
      .run();
    const response = await create("over-quota");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RESOURCE_QUOTA" }
    });
    expect(await countExtensions(db)).toBe(1);
    expect(await countRevisions(db)).toBe(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM extension_write_events")
        .first("n")
    ).toBe(1);
  });
  it.each([
    ["account", "owner", "extensions", 100],
    ["developer", "developer", "extensions", 100],
    ["account", "owner", "revisions", 1000],
    ["developer", "developer", "revisions", 1000],
    ["developer", "developer", "bytes", MAX_ACCOUNT_BYTES]
  ] as const)(
    "enforces %s %s retained %s quota",
    async (scope, subject, column, limit) => {
      await seedDeveloper("developer", "owner");
      expect((await create("first")).status).toBe(201);
      await ageEvents();
      const original = await db
        .prepare(
          `SELECT ${column} AS value FROM extension_resource_usage WHERE scope=? AND subject=?`
        )
        .bind(scope, subject)
        .first<number>("value");
      try {
        await db
          .prepare(
            `UPDATE extension_resource_usage SET ${column}=? WHERE scope=? AND subject=?`
          )
          .bind(limit, scope, subject)
          .run();
        expect((await create("blocked")).status).toBe(409);
        expect(await countExtensions(db)).toBe(1);
        expect(await countRevisions(db)).toBe(1);
      } finally {
        // Restore injected counter state; normal teardown verifies the real
        // accounting triggers, including the persistent global bucket.
        await db
          .prepare(
            `UPDATE extension_resource_usage SET ${column}=? WHERE scope=? AND subject=?`
          )
          .bind(original, scope, subject)
          .run();
      }
    }
  );
  it("rolls back approval when the published copy would exceed retained quota", async () => {
    await seedDeveloper("developer", "owner");
    await insertUser(db, { id: "mod", is_moderator: 1 });
    expect((await create("publication")).status).toBe(201);
    const revision = await db
      .prepare(
        "SELECT id FROM extension_revisions WHERE extension_id='publication'"
      )
      .first<string>("id");
    await db
      .prepare(
        "UPDATE extension_resource_usage SET bytes=? WHERE scope='account' AND subject='owner'"
      )
      .bind(MAX_ACCOUNT_BYTES)
      .run();
    const response = await post(
      `/extensions/v2/extensions/publication/revisions/${revision}/approve?notify=false`,
      await authHeaders("mod"),
      {}
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RESOURCE_QUOTA" }
    });
    expect(
      await db
        .prepare("SELECT status FROM extension_revisions WHERE id=?")
        .bind(revision)
        .first("status")
    ).toBe("pending");
    expect(
      await db
        .prepare("SELECT published_at FROM extensions WHERE id='publication'")
        .first("published_at")
    ).toBeNull();
  });
  it("accounts UTF-8 bytes exactly and releases them transactionally without shifting account charges", async () => {
    await seedDeveloper("developer", "owner");
    const content = { ...sampleCreate(), id: "multibyte", readme: "😀é" };
    const { id: _id, ...stored } = content;
    expect(
      (
        await post(
          "/extensions/v2/extensions",
          await authHeaders("owner"),
          content
        )
      ).status
    ).toBe(201);
    const bytes = new TextEncoder().encode(JSON.stringify(stored)).byteLength;
    expect(
      await db
        .prepare(
          "SELECT bytes FROM extension_resource_usage WHERE scope='account' AND subject='owner'"
        )
        .first("bytes")
    ).toBe(bytes);
    await insertUser(db, { id: "recipient" });
    await db
      .prepare(
        "UPDATE developers SET owner_user_id='recipient' WHERE id='developer'"
      )
      .run();
    expect(
      await db
        .prepare(
          "SELECT bytes FROM extension_resource_usage WHERE scope='account' AND subject='owner'"
        )
        .first("bytes")
    ).toBe(bytes);
    expect((await withdraw("multibyte", "recipient")).status).toBe(200);
    expect(
      await db
        .prepare(
          "SELECT bytes FROM extension_resource_usage WHERE scope='global'"
        )
        .first("bytes")
    ).toBe(0);
  });
});

describe("Bounded revision reads and maintenance", () => {
  it("pages metadata with equal timestamps, without selecting or parsing content", async () => {
    await owned();
    for (const id of ["a", "b", "c"]) await insertHistory(id);
    await insertUser(db, { id: "mod", is_moderator: 1 });
    const sql: string[] = [];
    env.DB_EXTENSIONS = wrapD1WithHook(db, (query) => {
      sql.push(query);
    });
    const headers = await authHeaders("mod");
    const first = await get(
      "/extensions/v2/revisions?status=rejected&limit=2",
      headers
    );
    const page = (await first.json()) as {
      result: Array<{ id: string; content?: unknown }>;
      pagination: { next_cursor: string };
    };
    expect(page.result.map((r) => r.id)).toEqual(["a", "b"]);
    expect(page.result.every((r) => !("content" in r))).toBe(true);
    const second = await get(
      `/extensions/v2/revisions?status=rejected&limit=2&cursor=${encodeURIComponent(page.pagination.next_cursor)}`,
      headers
    );
    await expect(second.json()).resolves.toMatchObject({
      result: [{ id: "c" }],
      pagination: { has_more: false }
    });
    const selection = sql.find(
      (q) => q.includes('from "extension_revisions"') && q.includes("order by")
    );
    expect(selection).toBeDefined();
    expect(selection?.split(" from ")[0]).not.toMatch(/"content"/);
    expect(
      (
        await get(
          "/extensions/v2/extensions/live/revisions/a",
          await authHeaders("intruder")
        )
      ).status
    ).toBe(403);
    const detail = await get(
      "/extensions/v2/extensions/live/revisions/a",
      await authHeaders("owner")
    );
    await expect(detail.json()).resolves.toMatchObject({
      result: {
        content: { name: sampleContent().name },
        content_available: true
      }
    });
  });
  it("rejects unsafe legacy release collections before sorting", async () => {
    await owned();
    for (const [id, releases] of [
      ["too-many", Array.from({ length: 101 }, () => ({ tag: "1.0.0" }))],
      ["bad-shape", [null]],
      ["huge-tag", [{ tag: "x".repeat(101) }]],
      ["huge-unicode-tag", [{ tag: "😀".repeat(101) }]],
      ["bad-tag", [{ tag: 1 }]],
      ["bad-array", "oops"]
    ] as const) {
      await insertRevision(db, {
        id,
        extension_id: "live",
        developer_id: "developer",
        submitted_by: "owner",
        content: JSON.stringify({ ...sampleContent(), releases }),
        status: "rejected",
        created_at: "2000-01-01"
      });
      const detail = await get(
        `/extensions/v2/extensions/live/revisions/${id}`,
        await authHeaders("owner")
      );
      expect(detail.status).toBe(409);
      await expect(detail.json()).resolves.toMatchObject({
        error: { code: "CONTENT_UNAVAILABLE" }
      });
      const list = await get(
        "/extensions/v2/extensions/live/revisions",
        await authHeaders("owner")
      );
      const body = (await list.json()) as {
        result: Array<{ id: string; content_available: boolean }>;
      };
      expect(
        body.result.find((revision) => revision.id === id)?.content_available
      ).toBe(false);
    }
  });
  it("keeps Unicode legacy tag availability consistent with detail reads", async () => {
    await owned();
    await insertRevision(db, {
      id: "unicode-tag",
      extension_id: "live",
      developer_id: "developer",
      submitted_by: "owner",
      content: JSON.stringify({
        releases: [{ ...sampleContent().releases[0], tag: "😀".repeat(100) }]
      }),
      status: "rejected"
    });
    const detail = await get(
      "/extensions/v2/extensions/live/revisions/unicode-tag",
      await authHeaders("owner")
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      result: { content_available: true }
    });
  });
  it("compacts only old reviewed bodies, preserves published/pending records and remains idempotent", async () => {
    await owned();
    for (const id of ["old", "published"]) await insertHistory(id, "approved");
    await db
      .prepare(
        "UPDATE extensions SET published_revision_id='published' WHERE id='live'"
      )
      .run();
    await insertRevision(db, {
      id: "pending",
      extension_id: "live",
      developer_id: "developer",
      submitted_by: "owner",
      content: JSON.stringify(sampleContent()),
      created_at: "2000-01-01 00:00:00"
    });
    await insertRevision(db, {
      id: "recent",
      extension_id: "live",
      developer_id: "developer",
      submitted_by: "owner",
      content: JSON.stringify(sampleContent()),
      status: "rejected",
      created_at: "2000-01-01 00:00:00",
      reviewed_at: "2099-01-01"
    });
    const before = await db
      .prepare(
        "SELECT bytes FROM extension_resource_usage WHERE scope='global'"
      )
      .first<number>("bytes");
    await maintainExtensionResources(getExtensionsDb(db), { mode: "compact" });
    const old = await db
      .prepare(
        "SELECT content,content_hash,compacted_at FROM extension_revisions WHERE id='old'"
      )
      .first<{ content: string; content_hash: string; compacted_at: string }>();
    expect(old?.content).toBe("{}");
    const expectedHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(sampleContent()))
        )
      ),
      (b) => b.toString(16).padStart(2, "0")
    ).join("");
    expect(old?.content_hash).toBe(expectedHash);
    expect(old?.compacted_at).toBeTruthy();
    for (const id of ["published", "pending", "recent"])
      expect(
        await db
          .prepare("SELECT compacted_at FROM extension_revisions WHERE id=?")
          .bind(id)
          .first("compacted_at")
      ).toBeNull();
    const after = await db
      .prepare(
        "SELECT bytes FROM extension_resource_usage WHERE scope='global'"
      )
      .first<number>("bytes");
    expect(after).toBeLessThan(before!);
    await maintainExtensionResources(getExtensionsDb(db), { mode: "compact" });
    expect(
      await db
        .prepare(
          "SELECT bytes FROM extension_resource_usage WHERE scope='global'"
        )
        .first("bytes")
    ).toBe(after);
    const detail = await get(
      "/extensions/v2/extensions/live/revisions/old",
      await authHeaders("owner")
    );
    await expect(detail.json()).resolves.toMatchObject({
      result: {
        content: null,
        content_available: false,
        content_hash: expectedHash
      }
    });
    expect(await countRevisions(db)).toBe(4);
  });
  it("keeps aggregate usage observational even above the former global caps", async () => {
    await seedDeveloper("developer", "owner");
    expect((await create("first")).status).toBe(201);
    await ageEvents();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await db
        .prepare(
          "UPDATE extension_resource_usage SET bytes=524288001, extensions=10001, revisions=100001 WHERE scope='global'"
        )
        .run();
      expect((await create("still-allowed")).status).toBe(201);
      await reportExtensionResources(getExtensionsDb(db));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await db
        .prepare(
          "UPDATE extension_resource_usage SET bytes=(SELECT COALESCE(SUM(published_bytes),0) FROM extensions)+(SELECT COALESCE(SUM(content_bytes),0) FROM extension_revisions), extensions=(SELECT COUNT(*) FROM extensions), revisions=(SELECT COUNT(*) FROM extension_revisions) WHERE scope='global'"
        )
        .run();
      warn.mockRestore();
    }
  });
  it("bounds response amplification for 100 maximum-sized bodies", async () => {
    await owned();
    await seedDeveloper("second", "second-owner");
    await insertExtension(db, { id: "second-live", developer_id: "second" });
    await insertUser(db, { id: "mod", is_moderator: 1 });
    const content = {
      ...sampleContent(),
      description: "\u0001".repeat(4000),
      readme: ""
    };
    const remaining =
      MAX_CONTENT_BYTES -
      new TextEncoder().encode(JSON.stringify(content)).byteLength;
    content.readme =
      "\0".repeat(Math.floor(remaining / 6)) + "x".repeat(remaining % 6);
    expect(ExtensionUpdateSchema.safeParse(content).success).toBe(true);
    for (let i = 0; i < 100; i++)
      await insertRevision(db, {
        id: `max-${i}`,
        extension_id: i < 50 ? "live" : "second-live",
        developer_id: i < 50 ? "developer" : "second",
        submitted_by: i < 50 ? "owner" : "second-owner",
        content: JSON.stringify(content),
        status: "rejected",
        created_at: "2000-01-01",
        reviewed_at: "2000-01-01"
      });
    const headers = await authHeaders("mod");
    const queue = await get(
      "/extensions/v2/revisions?status=rejected&limit=100",
      headers
    );
    const text = await queue.text();
    expect(queue.status).toBe(200);
    const responseBytes = new TextEncoder().encode(text).byteLength;
    expect(responseBytes).toBeLessThan(3 * 1024 * 1024);
    const result = JSON.parse(text).result as Array<Record<string, unknown>>;
    expect(result).toHaveLength(100);
    expect(result.every((row) => !("content" in row))).toBe(true);
    expect(result.every((row) => row.description === content.description)).toBe(
      true
    );
    const detail = await get(
      "/extensions/v2/extensions/live/revisions/max-0",
      headers
    );
    const detailBytes = new TextEncoder().encode(
      await detail.text()
    ).byteLength;
    expect(detail.status).toBe(200);
    // Detail repeats the bounded summary; escaped description characters can
    // add 24 KiB even when the canonical body is exactly at its limit.
    expect(detailBytes).toBeLessThan(MAX_CONTENT_BYTES + 32 * 1024);
  });
  it("previews retention and defaults to non-destructive scheduled runs", async () => {
    await owned();
    await insertHistory("old");
    const bytes = new TextEncoder().encode(
      JSON.stringify(sampleContent())
    ).byteLength;
    const queries: string[] = [];
    const hooked = wrapD1WithHook(db, (q) => {
      queries.push(q);
    });
    expect(await inventoryExtensionRetention(getExtensionsDb(hooked))).toEqual({
      eligible_bodies: 1,
      reclaimable_bytes: bytes - 2
    });
    await app.scheduled({} as ScheduledController, env);
    expect(
      await db
        .prepare("SELECT compacted_at FROM extension_revisions WHERE id='old'")
        .first("compacted_at")
    ).toBeNull();
    await maintainExtensionResources(getExtensionsDb(db), { mode: "invalid" });
    expect(
      await db
        .prepare("SELECT compacted_at FROM extension_revisions WHERE id='old'")
        .first("compacted_at")
    ).toBeNull();
    await maintainExtensionResources(getExtensionsDb(db), { mode: "compact" });
    expect(
      await db
        .prepare("SELECT compacted_at FROM extension_revisions WHERE id='old'")
        .first("compacted_at")
    ).toBeTruthy();
  });
  it("runs bounded cleanup and inventory hourly, keeping inventory read-only", async () => {
    await owned();
    await insertHistory("old");
    // Seed one prunable and one live write event so the run's pruning
    // behavior is observed on rows, not on captured SQL text.
    await db
      .prepare(
        "INSERT INTO extension_write_events VALUES ('expired','a','a',unixepoch()-86401)"
      )
      .run();
    await db
      .prepare(
        "INSERT INTO extension_write_events VALUES ('fresh','a','a',unixepoch()-120)"
      )
      .run();
    const queries: string[] = [];
    const hooked = wrapD1WithHook(db, (query) => {
      queries.push(query);
    });
    await maintainExtensionResources(getExtensionsDb(hooked));
    // Bounded cleanup is a per-statement-batch property (asserted by the
    // compaction batch-limit test below); the SQL wording itself is not
    // the contract.
    queries.length = 0;
    env.DB_EXTENSIONS = hooked;
    await app.scheduled({ cron: "0 * * * *" } as ScheduledController, env);
    expect(
      await db
        .prepare("SELECT compacted_at FROM extension_revisions WHERE id='old'")
        .first("compacted_at")
    ).toBeNull();
    // Expired write events are pruned; live ones survive.
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM extension_write_events WHERE id='expired'"
        )
        .first("n")
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM extension_write_events WHERE id='fresh'"
        )
        .first("n")
    ).toBe(1);
    queries.length = 0;
    const rowsBefore = await db
      .prepare("SELECT id, compacted_at FROM extension_revisions ORDER BY id")
      .all<{ id: string; compacted_at: string | null }>();
    await reportExtensionResources(getExtensionsDb(hooked), "compact");
    const rowsAfter = await db
      .prepare("SELECT id, compacted_at FROM extension_revisions ORDER BY id")
      .all<{ id: string; compacted_at: string | null }>();
    // Reporting must be observational: no revision row may change.
    expect(rowsAfter.results).toEqual(rowsBefore.results);
  });
  it.each([
    [{ repo: "example/repo" }, "custom"],
    [{ type: "bitbucket", repo: "example/repo" }, "custom"],
    [{ type: null, repo: "example/repo" }, "custom"],
    [{ type: 42, repo: "example/repo" }, "custom"],
    [{ type: "github", repo: "example/repo" }, "github"],
    [{ type: "gitlab", repo: "example/repo" }, "gitlab"],
    [{ type: "custom", repo: "example/repo" }, "custom"]
  ])(
    "normalizes legacy source %j to %s in public and owner cards",
    async (source, type) => {
      await owned();
      await db
        .prepare("UPDATE extensions SET source=? WHERE id='live'")
        .bind(JSON.stringify(source))
        .run();
      const extensions = new ExtensionsDatabase(getExtensionsDb(db));
      const publicCards = await extensions.list({});
      expect(publicCards.error).toBeNull();
      const publicCard = publicCards.data?.items[0];
      expect(publicCard?.source).toEqual({ type, repo: "example/repo" });
      expect(ExtensionListItemSchema.safeParse(publicCard).success).toBe(true);
      const ownerCards = await extensions.listOwned({
        developerId: "developer"
      });
      expect(ownerCards.error).toBeNull();
      const ownerCard = ownerCards.data?.items[0];
      expect(ownerCard?.published?.source).toEqual({
        type,
        repo: "example/repo"
      });
      expect(OwnedExtensionListItemSchema.safeParse(ownerCard).success).toBe(
        true
      );
      expect((await extensions.getById("live")).data?.source).toEqual(source);
    }
  );
  it("preserves under-limit legacy fields in public and owner details", async () => {
    await owned();
    const website = "https://example.test/" + "x".repeat(3000);
    const license = { name: "L".repeat(5000) };
    const source = { type: "custom", repo: "R".repeat(5000) };
    await db
      .prepare(
        "UPDATE extensions SET website=?, license=?, source=? WHERE id='live'"
      )
      .bind(website, JSON.stringify(license), JSON.stringify(source))
      .run();
    const extensions = new ExtensionsDatabase(getExtensionsDb(db));
    const cards = await extensions.list({});
    expect(cards.error).toBeNull();
    expect(
      ExtensionListItemSchema.safeParse(cards.data?.items[0]).success
    ).toBe(true);
    expect(cards.data?.items[0]).toMatchObject({
      website: null,
      license: { name: "L".repeat(100) },
      source: { type: "custom", repo: "R".repeat(500) }
    });
    const publicDetail = await extensions.getById("live");
    expect(publicDetail.error).toBeNull();
    expect(publicDetail.data).toMatchObject({ website, license, source });
    const ownerDetail = await extensions.getOwned("live");
    expect(ownerDetail.error).toBeNull();
    expect(ownerDetail.data?.extension.published).toMatchObject({
      website,
      license,
      source
    });
  });
  it("limits maintenance work per invocation", async () => {
    await owned();
    for (let i = 0; i <= MAINTENANCE_BATCH_SIZE; i++)
      await insertHistory(`old-${i}`);
    await maintainExtensionResources(getExtensionsDb(db), { mode: "compact" });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM extension_revisions WHERE compacted_at IS NOT NULL"
        )
        .first("n")
    ).toBe(MAINTENANCE_BATCH_SIZE);
    await maintainExtensionResources(getExtensionsDb(db), { mode: "compact" });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM extension_revisions WHERE compacted_at IS NOT NULL"
        )
        .first("n")
    ).toBe(MAINTENANCE_BATCH_SIZE + 1);
  });
  it("keeps oversized legacy bodies out of queue/detail reads and automatic compaction", async () => {
    await owned();
    await insertHistory("legacy");
    // Emulate an imported pre-0026 row transactionally, restoring the guard
    // before any request. Admission must never allow this for new content.
    const trigger = await db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='extension_revision_content_bound'"
      )
      .first<string>("sql");
    await db.batch([
      db.prepare("DROP TRIGGER extension_revision_content_bound"),
      db
        .prepare("UPDATE extension_revisions SET content=? WHERE id='legacy'")
        .bind("x".repeat(MAX_CONTENT_BYTES + 1)),
      db.prepare(trigger!)
    ]);
    const list = await get(
      "/extensions/v2/extensions/live/revisions",
      await authHeaders("owner")
    );
    await expect(list.json()).resolves.toMatchObject({
      result: [
        {
          id: "legacy",
          content_available: false,
          content_bytes: MAX_CONTENT_BYTES + 1
        }
      ]
    });
    const detail = await get(
      "/extensions/v2/extensions/live/revisions/legacy",
      await authHeaders("owner")
    );
    expect(detail.status).toBe(409);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await maintainExtensionResources(getExtensionsDb(db), {
        mode: "compact"
      });
      await reportExtensionResources(getExtensionsDb(db), "compact");
      expect(warn).toHaveBeenCalledTimes(1);
      const entry = warn.mock.calls[0][0] as {
        context: { reason: string };
      };
      expect(entry.context.reason).toBe("legacy_content_present");
      const logged = JSON.stringify(warn.mock.calls[0]);
      expect(logged).not.toContain("owner");
      expect(logged).not.toContain(sampleContent().name);
    } finally {
      warn.mockRestore();
    }
    expect(
      await db
        .prepare(
          "SELECT compacted_at FROM extension_revisions WHERE id='legacy'"
        )
        .first("compacted_at")
    ).toBeNull();
  });
});
