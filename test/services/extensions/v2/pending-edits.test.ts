import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { wrapD1WithHook } from "./db-interceptor";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  post,
  put,
  sampleCreate,
  sampleContent,
  seedDeveloper
} from "./harness";
import {
  getRevision,
  getExtension,
  listRevisions,
  insertUser,
  bumpDeveloperOwnership,
  insertRevision,
  insertUnpublishedExtension
} from "./db-fixtures";
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);
setupExtensionsV2Tests();
const root = "/extensions/v2/extensions/new-ext";
async function pending() {
  await seedDeveloper("dev", "owner");
  const response = await post(
    "/extensions/v2/extensions",
    await authHeaders("owner"),
    sampleCreate()
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { result: { revision_id: string } }).result
    .revision_id;
}
async function replace(id: string, user = "owner") {
  return put(
    `${root}/revisions/${id}`,
    await authHeaders(user),
    sampleContent({ name: "Updated" })
  );
}
async function moderator() {
  await insertUser(db, { id: "moderator", is_moderator: 1 });
  return authHeaders("moderator");
}
describe("pending submission replacement", () => {
  it("rotates pending identity without publishing and rejects stale edits and decisions", async () => {
    const old = await pending();
    const response = await replace(old);
    expect(response.status).toBe(202);
    const { result } = (await response.json()) as {
      result: { revision_id: string };
    };
    expect(result.revision_id).not.toBe(old);
    expect(await getRevision(db, old)).toBeNull();
    expect(
      JSON.parse((await getRevision(db, result.revision_id))!.content!)
    ).toMatchObject({ name: "Updated" });
    expect((await getExtension(db, "new-ext"))!.published_at).toBeNull();
    expect((await replace(old)).status).toBe(409);
    for (const action of ["approve", "reject"]) {
      const stale = await post(
        `${root}/revisions/${old}/${action}`,
        await moderator(),
        action === "reject" ? { review_note: "Requested changes" } : {}
      );
      expect(stale.status).toBe(404);
    }
    expect(await listRevisions(db)).toHaveLength(1);
  });
  it("lets the owner replace a publisher submission and attributes the replacement to the owner", async () => {
    await seedDeveloper("dev", "owner");
    await insertUnpublishedExtension(db, {
      identifier: "new-ext",
      developer_identifier: "dev"
    });
    await insertRevision(db, {
      id: "publisher-revision",
      extension_identifier: "new-ext",
      developer_identifier: "dev",
      submitted_by: "publisher-client",
      content: JSON.stringify(sampleContent())
    });
    expect(
      (await replace("publisher-revision", "publisher-client")).status
    ).toBe(403);
    expect((await getRevision(db, "publisher-revision"))!.submitted_by).toBe(
      "publisher-client"
    );
    const response = await replace("publisher-revision");
    expect(response.status).toBe(202);
    const { result } = (await response.json()) as {
      result: { revision_id: string };
    };
    expect((await getRevision(db, result.revision_id))!.submitted_by).toBe(
      "owner"
    );
    expect(await getRevision(db, "publisher-revision")).toBeNull();
    expect(await listRevisions(db)).toHaveLength(1);
  });
  it.each(["new-ext", "New-Ext"])(
    "returns canonical stored extension casing for %s",
    async (extensionId) => {
      await seedDeveloper("dev", "owner");
      await insertUnpublishedExtension(db, {
        identifier: extensionId,
        developer_identifier: "dev"
      });
      await insertRevision(db, {
        id: "canonical-revision",
        extension_identifier: extensionId,
        developer_identifier: "dev",
        submitted_by: "owner",
        content: JSON.stringify(sampleContent())
      });
      const response = await put(
        "/extensions/v2/extensions/NEW-EXT/revisions/canonical-revision",
        await authHeaders("owner"),
        sampleContent({ name: "Updated" })
      );
      expect(response.status).toBe(202);
      const { result } = (await response.json()) as {
        result: { id: string; identifier: string; revision_id: string };
      };
      expect(result.identifier).toBe(extensionId);
      expect((await getRevision(db, result.revision_id))!.extension_id).toBe(
        (await getExtension(db, extensionId))!.id
      );
    }
  );
  it("preserves the published version and reviewed history", async () => {
    const approved = await pending();
    expect(
      (
        await post(
          `${root}/revisions/${approved}/approve`,
          await moderator(),
          {}
        )
      ).status
    ).toBe(200);
    const next = await put(
      root,
      await authHeaders("owner"),
      sampleContent({ name: "Proposed" })
    );
    const { result } = (await next.json()) as {
      result: { revision_id: string };
    };
    expect((await replace(result.revision_id)).status).toBe(202);
    expect((await getExtension(db, "new-ext"))!.name).toBe("New Extension");
    expect((await getRevision(db, approved))!.status).toBe("approved");
    expect(await listRevisions(db)).toHaveLength(2);
  });
  it("rejects a review that won the race without creating another submission", async () => {
    const old = await pending();
    const headers = await moderator();
    let fired = false;
    env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
      if (!fired && sql.includes("DELETE FROM extension_revisions")) {
        fired = true;
        // The competing request uses the real binding, then restore the hook.
        const hooked = env.DB_EXTENSIONS;
        env.DB_EXTENSIONS = db;
        expect(
          (await post(`${root}/revisions/${old}/approve`, headers, {})).status
        ).toBe(200);
        env.DB_EXTENSIONS = hooked;
      }
    });
    expect((await replace(old)).status).toBe(409);
    expect((await getRevision(db, old))!.status).toBe("approved");
    expect(await listRevisions(db)).toHaveLength(1);
  });
  it("rolls back deletion if the new revision cannot be inserted", async () => {
    const old = await pending();
    env.DB_EXTENSIONS = wrapD1WithHook(db, (sql) => {
      if (sql.includes("INSERT INTO extension_revisions"))
        return db.prepare("INSERT INTO extension_revisions (id) VALUES (NULL)");
    });
    expect((await replace(old)).status).toBe(503);
    expect((await getRevision(db, old))!.status).toBe("pending");
    expect(await listRevisions(db)).toHaveLength(1);
  });
  it("enforces owner, active account, and ownership epoch checks", async () => {
    const old = await pending();
    expect((await replace(old, "other")).status).toBe(403);
    await bumpDeveloperOwnership(db, "dev", "owner");
    expect((await replace(old)).status).toBe(409);
    await db
      .prepare(
        "UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'owner'"
      )
      .run();
    expect((await replace(old)).status).toBe(403);
    expect((await getRevision(db, old))!.status).toBe("pending");
  });
  it("does not publish approval content prepared before a replacement", async () => {
    const old = await pending();
    const headers = await moderator();
    let fired = false;
    env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
      if (!fired && sql.includes("SET status = 'approved'")) {
        fired = true;
        const hooked = env.DB_EXTENSIONS;
        env.DB_EXTENSIONS = db;
        expect((await replace(old)).status).toBe(202);
        env.DB_EXTENSIONS = hooked;
      }
    });
    expect(
      (await post(`${root}/revisions/${old}/approve`, headers, {})).status
    ).toBe(409);
    expect(fired).toBe(true);
    expect((await getExtension(db, "new-ext"))!.published_at).toBeNull();
    expect((await listRevisions(db))[0].status).toBe("pending");
  });
  it("keeps the pending revision when rate admission rejects a replacement", async () => {
    let current = await pending();
    for (let i = 0; i < 4; i++) {
      const response = await replace(current);
      expect(response.status).toBe(202);
      current = ((await response.json()) as { result: { revision_id: string } })
        .result.revision_id;
    }
    const response = await replace(current);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect((await getRevision(db, current))!.status).toBe("pending");
    expect(await listRevisions(db)).toHaveLength(1);
  });
  it("validates the replacement before changing the pending submission", async () => {
    const old = await pending();
    expect(
      (
        await put(`${root}/revisions/${old}`, await authHeaders("owner"), {
          name: "Invalid"
        })
      ).status
    ).toBe(422);
    expect((await getRevision(db, old))!.status).toBe("pending");
  });
});
