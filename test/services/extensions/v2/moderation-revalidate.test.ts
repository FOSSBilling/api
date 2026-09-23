import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  post,
  put,
  del,
  sampleCreate,
  sampleDeveloper
} from "./harness";
import {
  insertUser,
  insertDeveloper,
  insertExtension,
  insertDeveloperClaim,
  insertUnpublishedExtension
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

// Only needs to match what this suite puts in the environment; the frontend
// worker compares the two in production.
const SECRET = "test-extensions-revalidate-secret";

type FetcherStub = { fetch: ReturnType<typeof vi.fn> };

function stubFrontend(status = 200): FetcherStub {
  const fetcher: FetcherStub = {
    fetch: vi.fn(async () => new Response("{}", { status }))
  };
  const bindings = env as unknown as Record<string, unknown>;
  bindings.EXTENSIONS_FRONTEND = fetcher;
  bindings.EXTENSIONS_REVALIDATE_SECRET = SECRET;
  return fetcher;
}

function fetchCalls(fetcher: FetcherStub): Array<[unknown, RequestInit]> {
  return (fetcher.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<
    [unknown, RequestInit]
  >;
}

afterEach(() => {
  const bindings = env as unknown as Record<string, unknown>;
  delete bindings.EXTENSIONS_FRONTEND;
  delete bindings.EXTENSIONS_REVALIDATE_SECRET;
});

async function seedModAndExtension(): Promise<void> {
  await insertUser(db, { id: "mod-1", is_moderator: 1 });
  await insertUser(db, { id: "user-1", email: "owner@example.com" });
  await insertDeveloper(db, {
    id: "new-developer",
    type: "user",
    name: "New Developer",
    url: null,
    owner_user_id: "user-1"
  });
  await insertExtension(db, {
    id: "live-ext",
    developer_id: "new-developer"
  });
}

// notify=false keeps the email provider out of these tests entirely; the
// notification behaviour has its own suite (moderation-notify.test.ts).
async function delist(as: string): Promise<Response> {
  return post(
    "/extensions/v2/extensions/live-ext/delist?notify=false",
    await authHeaders(as),
    { reason: "Upstream source removed" }
  );
}

describe("CDN cache revalidation on catalogue mutations", () => {
  it("purges the catalogue tags after a successful delist", async () => {
    await seedModAndExtension();
    const fetcher = stubFrontend();

    const res = await delist("mod-1");
    expect(res.status).toBe(200);

    expect(fetchCalls(fetcher)).toHaveLength(1);
    const [url, init] = fetchCalls(fetcher)[0];
    expect(String(url)).toBe(
      "https://extensions.fossbilling.org/api/revalidate"
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json"
    });
    expect(JSON.parse(String(init.body))).toEqual({
      tags: ["catalogue", "developers"]
    });
  });

  it("purges the catalogue tags after a successful relist", async () => {
    await seedModAndExtension();
    expect((await delist("mod-1")).status).toBe(200);
    const fetcher = stubFrontend();

    const res = await post(
      "/extensions/v2/extensions/live-ext/relist?notify=false",
      await authHeaders("mod-1"),
      {}
    );
    expect(res.status).toBe(200);

    expect(fetchCalls(fetcher)).toHaveLength(1);
    const [url, init] = fetchCalls(fetcher)[0];
    expect(String(url)).toBe(
      "https://extensions.fossbilling.org/api/revalidate"
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      tags: ["catalogue", "developers"]
    });
  });

  it("purges after a revision approval", async () => {
    await seedModAndExtension();
    const created = await post(
      "/extensions/v2/extensions",
      await authHeaders("user-1"),
      sampleCreate({ extensionId: "approve-rev" })
    );
    expect(created.status).toBe(201);
    const { result } = (await created.json()) as {
      result: { id: string; revision_id: string };
    };
    const fetcher = stubFrontend();

    const res = await post(
      `/extensions/v2/extensions/${result.id}/revisions/${result.revision_id}/approve?notify=false`,
      await authHeaders("mod-1"),
      {}
    );
    expect(res.status).toBe(200);
    expect(fetchCalls(fetcher)).toHaveLength(1);
  });

  it("purges after a revision rejection", async () => {
    await seedModAndExtension();
    const created = await post(
      "/extensions/v2/extensions",
      await authHeaders("user-1"),
      sampleCreate({ extensionId: "reject-rev" })
    );
    expect(created.status).toBe(201);
    const { result } = (await created.json()) as {
      result: { id: string; revision_id: string };
    };
    const fetcher = stubFrontend();

    const res = await post(
      `/extensions/v2/extensions/${result.id}/revisions/${result.revision_id}/reject?notify=false`,
      await authHeaders("mod-1"),
      { review_note: "Needs work" }
    );
    expect(res.status).toBe(200);
    expect(fetchCalls(fetcher)).toHaveLength(1);
  });

  it("purges after an approved claim", async () => {
    await insertUser(db, { id: "mod-1", is_moderator: 1 });
    await insertUser(db, { id: "claimant-1", email: "claimant@example.com" });
    await insertDeveloper(db, {
      id: "legacy-dev",
      type: "user",
      name: "Legacy",
      url: null,
      owner_user_id: null
    });
    await insertDeveloperClaim(db, {
      id: "claim-1",
      developer_id: "legacy-dev",
      claimant_id: "claimant-1"
    });
    const fetcher = stubFrontend();

    const res = await post(
      "/extensions/v2/developers/claims/claim-1/approve?notify=false",
      await authHeaders("mod-1")
    );
    expect(res.status).toBe(200);
    expect(fetchCalls(fetcher)).toHaveLength(1);
  });

  it("purges after an owner withdraws an unpublished extension", async () => {
    await insertUser(db, { id: "user-1", email: "owner@example.com" });
    await insertDeveloper(db, {
      id: "new-developer",
      type: "user",
      name: "New Developer",
      url: null,
      owner_user_id: "user-1"
    });
    await insertUnpublishedExtension(db, {
      id: "draft-ext",
      developer_id: "new-developer"
    });
    const fetcher = stubFrontend();

    const res = await del(
      "/extensions/v2/extensions/draft-ext",
      await authHeaders("user-1")
    );
    expect(res.status).toBe(200);
    expect(fetchCalls(fetcher)).toHaveLength(1);
  });

  it("purges after a developer profile upsert", async () => {
    const fetcher = stubFrontend();

    const res = await put(
      "/extensions/v2/developers/me",
      await authHeaders("user-1"),
      sampleDeveloper()
    );
    expect(res.status).toBe(200);
    expect(fetchCalls(fetcher)).toHaveLength(1);
  });

  it("purges after a developer profile deletion", async () => {
    // An approved profile with no attached extensions is deletable and
    // still public content, so the delete path must purge too.
    await insertUser(db, { id: "user-1", email: "owner@example.com" });
    await insertDeveloper(db, {
      id: "doomed-dev",
      type: "user",
      name: "Doomed",
      url: null,
      owner_user_id: "user-1",
      approved_at: new Date().toISOString()
    });
    const fetcher = stubFrontend();

    const res = await del(
      "/extensions/v2/developers/me",
      await authHeaders("user-1")
    );
    expect(res.status).toBe(200);
    expect(fetchCalls(fetcher)).toHaveLength(1);
  });

  it("skips the purge when no secret is configured", async () => {
    await seedModAndExtension();
    const fetcher = stubFrontend();
    delete (env as unknown as Record<string, unknown>)
      .EXTENSIONS_REVALIDATE_SECRET;

    const res = await delist("mod-1");
    expect(res.status).toBe(200);
    expect(fetchCalls(fetcher)).toHaveLength(0);
  });

  it("still delists when the purge returns an error status", async () => {
    await seedModAndExtension();
    stubFrontend(502);

    const res = await delist("mod-1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      result: { id: "live-ext", status: "delisted" }
    });
  });

  it("still delists when the purge request throws", async () => {
    await seedModAndExtension();
    const fetcher: FetcherStub = {
      fetch: vi.fn(async () => {
        throw new Error("binding unavailable");
      })
    };
    (env as unknown as Record<string, unknown>).EXTENSIONS_FRONTEND = fetcher;
    (env as unknown as Record<string, unknown>).EXTENSIONS_REVALIDATE_SECRET =
      SECRET;

    const res = await delist("mod-1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      result: { status: "delisted" }
    });
    expect(fetchCalls(fetcher)).toHaveLength(1);
  });

  it("does not purge when the mutation itself fails", async () => {
    await seedModAndExtension();
    const fetcher = stubFrontend();

    // A non-moderator is rejected by requireModerator before any write.
    const res = await delist("user-1");
    expect(res.status).toBe(403);
    expect(fetchCalls(fetcher)).toHaveLength(0);
  });
});
