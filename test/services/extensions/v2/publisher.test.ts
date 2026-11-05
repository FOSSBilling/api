import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  setupExtensionsV2Tests,
  authHeaders,
  post,
  put,
  get,
  del,
  sampleCreate,
  sampleContent,
  seedDeveloper,
  seedUnownedDeveloper,
  db
} from "./harness";
import {
  insertUser,
  insertExtension,
  bumpDeveloperOwnership
} from "./db-fixtures";
import {
  signAccessToken,
  activateM2mJwks,
  deactivateM2mJwks
} from "../../../lib/auth/m2m-helper";

// Hoisted so no v2 suite can make a real GitHub call (see moderation.test.ts).
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

const CLIENT = "modules-publisher";
const DEVELOPER = "foss-developer";
const OWNER = "owner-1";
const MODERATOR = "mod-1";

async function m2mHeaders(
  scopes: string[],
  overrides?: { clientId?: string; aud?: string; typ?: string }
): Promise<Record<string, string>> {
  const token = await signAccessToken({
    clientId: overrides?.clientId ?? CLIENT,
    scopes,
    aud: overrides?.aud,
    typ: overrides?.typ
  });
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

async function registerPublisher(canPublish = true): Promise<Response> {
  return put(`/v2/m2m/clients/${CLIENT}`, await authHeaders(MODERATOR), {
    developer_id: DEVELOPER,
    can_publish: canPublish
  });
}

async function revisionRow(id: string) {
  return db
    .prepare("SELECT * FROM extension_revisions WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

setupExtensionsV2Tests();

describe("m2m publisher registration", () => {
  beforeEach(async () => {
    await activateM2mJwks();
  });
  afterEach(() => {
    deactivateM2mJwks();
  });

  it("requires a moderator", async () => {
    await insertUser(db, { id: OWNER });
    const res = await put(
      `/v2/m2m/clients/${CLIENT}`,
      await authHeaders(OWNER),
      { developer_id: DEVELOPER, can_publish: true }
    );
    expect(res.status).toBe(403);
  });

  it("registers a client and ensures its synthetic user", async () => {
    await insertUser(db, { id: MODERATOR, is_moderator: 1 });
    await seedDeveloper(DEVELOPER, OWNER);
    const res = await registerPublisher();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        client_id: string;
        developer_id: string;
        can_publish: boolean;
        revoked_at: string | null;
      };
    };
    expect(body.result).toMatchObject({
      client_id: CLIENT,
      developer_id: DEVELOPER,
      can_publish: true,
      revoked_at: null
    });
    const synthetic = await db
      .prepare("SELECT id FROM users WHERE id = ?")
      .bind(`m2m:${CLIENT}`)
      .first();
    expect(synthetic).not.toBeNull();
  });

  it("rejects unknown and unclaimed developers", async () => {
    await insertUser(db, { id: MODERATOR, is_moderator: 1 });
    await seedUnownedDeveloper("unclaimed-dev");
    const missing = await put(
      `/v2/m2m/clients/${CLIENT}`,
      await authHeaders(MODERATOR),
      { developer_id: "no-such-developer", can_publish: true }
    );
    expect(missing.status).toBe(404);
    const unclaimed = await put(
      `/v2/m2m/clients/${CLIENT}`,
      await authHeaders(MODERATOR),
      { developer_id: "unclaimed-dev", can_publish: true }
    );
    expect(unclaimed.status).toBe(404);
  });

  it("lists mappings", async () => {
    await insertUser(db, { id: MODERATOR, is_moderator: 1 });
    await seedDeveloper(DEVELOPER, OWNER);
    await registerPublisher();
    const res = await get("/v2/m2m/clients", await authHeaders(MODERATOR));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: Array<{ client_id: string }>;
    };
    expect(body.result).toHaveLength(1);
    expect(body.result[0].client_id).toBe(CLIENT);
  });
});

describe("m2m publisher writes", () => {
  beforeEach(async () => {
    await activateM2mJwks();
    await insertUser(db, { id: MODERATOR, is_moderator: 1 });
    await seedDeveloper(DEVELOPER, OWNER);
  });
  afterEach(() => {
    deactivateM2mJwks();
  });

  it("creates an extension under the mapped developer", async () => {
    await registerPublisher();
    const res = await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:push"]),
      sampleCreate({ extensionId: "published-ext" })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      result: { revision_id: string };
    };
    const revision = await revisionRow(body.result.revision_id);
    expect(revision?.submitted_by).toBe(`m2m:${CLIENT}`);
    expect(revision?.developer_id).toBe(DEVELOPER);
    const ext = await db
      .prepare("SELECT created_by FROM extensions WHERE id = ?")
      .bind("published-ext")
      .first<{ created_by: string }>();
    expect(ext?.created_by).toBe(OWNER);
  });

  it("proposes an edit to an extension of the mapped developer", async () => {
    await registerPublisher();
    await insertExtension(db, {
      id: "existing-ext",
      developer_id: DEVELOPER,
      name: "Existing",
      source: '{"type":"github","repo":"example/existing"}'
    });
    const res = await put(
      "/v2/extensions/existing-ext",
      await m2mHeaders(["extensions:push"]),
      sampleContent({ name: "Edited" })
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      result: { revision_id: string };
    };
    const revision = await revisionRow(body.result.revision_id);
    expect(revision?.submitted_by).toBe(`m2m:${CLIENT}`);
  });

  it("rejects writes for an unregistered client", async () => {
    await insertExtension(db, {
      id: "existing-ext",
      developer_id: DEVELOPER,
      name: "Existing",
      source: '{"type":"github","repo":"example/existing"}'
    });
    const res = await put(
      "/v2/extensions/existing-ext",
      await m2mHeaders(["extensions:push"]),
      sampleContent({ name: "Edited" })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { message: string; code: string };
    };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("rejects writes without the required scope", async () => {
    await registerPublisher();
    const res = await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:publish"]),
      sampleCreate({ extensionId: "no-push-scope" })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { message: string };
    };
    expect(body.error.message).toContain("extensions:push");
  });

  it("rejects a revoked mapping without waiting out the token", async () => {
    await registerPublisher();
    await del(`/v2/m2m/clients/${CLIENT}`, await authHeaders(MODERATOR));
    const res = await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:push"]),
      sampleCreate({ extensionId: "revoked-client" })
    );
    expect(res.status).toBe(403);
  });

  it("rejects machine tokens on human-only routes", async () => {
    await registerPublisher();
    // Machine tokens are not a recognized user credential: role-aware reads
    // fall back to the anonymous projection, and mine requires a bearer.
    const mine = await get(
      "/v2/extensions?scope=mine",
      await m2mHeaders(["extensions:push"])
    );
    expect(mine.status).toBe(401);
    const profile = await get(
      "/v2/users/me",
      await m2mHeaders(["extensions:push"])
    );
    expect(profile.status).toBe(403);
    const queue = await get(
      "/v2/revisions",
      await m2mHeaders(["extensions:push"])
    );
    expect(queue.status).toBe(403);
  });

  it("answers 401 for a token bound to another audience", async () => {
    const res = await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:push"], { aud: "https://other.example" }),
      sampleCreate({ extensionId: "wrong-aud" })
    );
    expect(res.status).toBe(401);
  });

  it("stops writing after an ownership transfer and recovers on re-registration", async () => {
    await registerPublisher();
    // The mapping holds the epoch from registration; the transfer bumps it.
    await bumpDeveloperOwnership(db, DEVELOPER, "new-owner-1");

    const stale = await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:push"]),
      sampleCreate({ extensionId: "stale-after-transfer" })
    );
    expect(stale.status).toBe(403);
    const staleBody = (await stale.json()) as { error: { message: string } };
    expect(staleBody.error.message).toContain("stale");

    // Re-registering rebinds to the new epoch and un-revokes.
    const reregistered = await registerPublisher();
    expect(reregistered.status).toBe(200);
    const res = await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:push"]),
      sampleCreate({ extensionId: "rebound-after-transfer" })
    );
    expect(res.status).toBe(201);
  });
});

describe("m2m publisher auto-approval", () => {
  beforeEach(async () => {
    await activateM2mJwks();
    await insertUser(db, { id: MODERATOR, is_moderator: 1 });
    await seedDeveloper(DEVELOPER, OWNER);
  });
  afterEach(() => {
    deactivateM2mJwks();
  });

  it("publishes a pending revision when can_publish is set", async () => {
    await registerPublisher(true);
    const created = await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:push", "extensions:publish"]),
      sampleCreate({ extensionId: "auto-published" })
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      result: { revision_id: string };
    };
    const revisionId = createdBody.result.revision_id;

    const approved = await post(
      `/v2/extensions/auto-published/revisions/${revisionId}/approve?notify=false`,
      await m2mHeaders(["extensions:publish"]),
      {}
    );
    expect(approved.status).toBe(200);

    const revision = await revisionRow(revisionId);
    expect(revision?.status).toBe("approved");
    expect(revision?.reviewer_id).toBe(`m2m:${CLIENT}`);
    expect(String(revision?.review_note)).toContain(
      `[auto publisher=${CLIENT}]`
    );
    const ext = await db
      .prepare(
        "SELECT published_at, published_revision_id FROM extensions WHERE id = ?"
      )
      .bind("auto-published")
      .first<{ published_at: string | null; published_revision_id: string }>();
    expect(ext?.published_at).not.toBeNull();
    expect(ext?.published_revision_id).toBe(revisionId);
  });

  it("rejects approval when the mapping lacks can_publish", async () => {
    await registerPublisher(false);
    const created = await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:push"]),
      sampleCreate({ extensionId: "no-auto-publish" })
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      result: { revision_id: string };
    };
    const revisionId = createdBody.result.revision_id;

    const approved = await post(
      `/v2/extensions/no-auto-publish/revisions/${revisionId}/approve?notify=false`,
      await m2mHeaders(["extensions:publish"]),
      {}
    );
    expect(approved.status).toBe(403);
    const body = (await approved.json()) as {
      error: { message: string };
    };
    expect(body.error.message).toContain("cannot publish");
  });

  it("rejects approval without the publish scope", async () => {
    await registerPublisher(true);
    const created = await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:push"]),
      sampleCreate({ extensionId: "scope-gate" })
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      result: { revision_id: string };
    };
    const revisionId = createdBody.result.revision_id;

    const approved = await post(
      `/v2/extensions/scope-gate/revisions/${revisionId}/approve?notify=false`,
      await m2mHeaders(["extensions:push"]),
      {}
    );
    expect(approved.status).toBe(403);
    const body = (await approved.json()) as {
      error: { message: string };
    };
    expect(body.error.message).toContain("extensions:publish");
  });

  it("keeps moderator approval working alongside the carve-out", async () => {
    await registerPublisher(true);
    await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:push"]),
      sampleCreate({ extensionId: "mod-approved" })
    );
    const pending = await get(
      "/v2/revisions?status=pending",
      await authHeaders(MODERATOR)
    );
    expect(pending.status).toBe(200);
    const { result } = (await pending.json()) as {
      result: Array<{ id: string }>;
    };
    expect(result).toHaveLength(1);
    const approved = await post(
      `/v2/extensions/mod-approved/revisions/${result[0].id}/approve?notify=false`,
      await authHeaders(MODERATOR),
      {}
    );
    expect(approved.status).toBe(200);
    const revision = await revisionRow(result[0].id);
    expect(revision?.reviewer_id).toBe(MODERATOR);
  });
});

describe("m2m write pacing", () => {
  beforeEach(async () => {
    await activateM2mJwks();
  });
  afterEach(() => {
    deactivateM2mJwks();
  });

  it("paces machine clients under their client key", async () => {
    await insertUser(db, { id: MODERATOR, is_moderator: 1 });
    await seedDeveloper(DEVELOPER, OWNER);
    await registerPublisher();

    const keys: string[] = [];
    env.EXTENSION_WRITE_RATE_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      }
    };
    await post(
      "/v2/extensions",
      await m2mHeaders(["extensions:push"]),
      sampleCreate({ extensionId: "paced-ext" })
    );
    expect(keys).toContain(`client:${CLIENT}`);
  });
});
