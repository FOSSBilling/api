import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";

// Mocked so DevelopersDatabase.claim()'s GitHub entity-existence check never
// makes a real network call. Defaults to "not found" (matching classifyGitHubError's
// NotFoundError check in github-verification.ts), which makes claim() fall
// back to today's unverified/manual-review path — the same behavior these
// pre-existing tests expect. Individual tests override this to exercise the
// verified/mismatch paths.
vi.mock("@octokit/request", () => {
  const endpoint = { DEFAULTS: {} };
  const derivedFn = Object.assign(vi.fn(), { defaults: vi.fn(), endpoint });
  const request = Object.assign(vi.fn(), {
    defaults: vi.fn().mockReturnValue(derivedFn),
    endpoint
  });
  return { request };
});

import { request as ghRequest } from "@octokit/request";
import app from "../../../../src/app";
import { createMockD1, createTables, MockTables } from "./mock-db";
import { signAssertion } from "../../../lib/auth/assertion-helper";
import { MockGitHubRequest } from "../../../utils/test-types";

function mockGithubEntityNotFound(): void {
  (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(async () => {
    throw Object.assign(new Error("Not Found"), { status: 404 });
  });
}

function mockGithubEntity(type: "User" | "Organization"): void {
  (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(async () => ({
    data: { type }
  }));
}

// Matches the ASSERTION_SIGNING_SECRET binding configured in vitest.config.ts.
const SECRET = "test-assertion-signing-secret";

let tables: MockTables;

beforeEach(() => {
  tables = createTables();
  env.DB_EXTENSIONS = createMockD1(tables);
  vi.clearAllMocks();
  mockGithubEntityNotFound();
});

async function authHeaders(sub: string): Promise<Record<string, string>> {
  const token = await signAssertion(SECRET, { sub });
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

function samplePayload(overrides?: {
  extensionId?: string;
  developerId?: string;
}) {
  return {
    developer: {
      id: overrides?.developerId ?? "new-developer",
      type: "user",
      name: "Some Developer",
      URL: "https://example.com"
    },
    extension: {
      id: overrides?.extensionId ?? "new-ext",
      type: "mod",
      name: "New Extension",
      description: "A new extension",
      releases: [
        {
          tag: "1.0.0",
          date: "2026-01-01T00:00:00Z",
          download_url: "https://example.com/download.zip",
          min_fossbilling_version: "0.6"
        }
      ],
      website: "https://example.com",
      license: { name: "MIT" },
      readme: "# Readme",
      source: { type: "github", repo: "example/new-ext" },
      version: "1.0.0",
      download_url: "https://example.com/download.zip"
    }
  };
}

// Extension submissions now require the named developer to already exist
// (created via PUT /developers/me) and be owned by the caller.
function seedDeveloper(id: string, ownerUserId: string): void {
  tables.developers.set(id, {
    id,
    type: "user",
    name: "Developer",
    url: null,
    owner_user_id: ownerUserId
  });
}

function seedUnownedDeveloper(id: string, name = "Legacy Developer"): void {
  tables.developers.set(id, {
    id,
    type: "user",
    name,
    url: null,
    owner_user_id: null,
    approved_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
}

function seedOwnedExtension(): void {
  tables.developers.set("owner-developer", {
    id: "owner-developer",
    type: "user",
    name: "Owner",
    url: null,
    owner_user_id: "owner-1"
  });
  tables.extensions.set("existing-ext", {
    id: "existing-ext",
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
}

async function post(
  path: string,
  headers: Record<string, string>,
  body?: unknown
) {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    },
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function get(path: string, headers: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await app.request(path, { headers }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function del(path: string, headers: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await app.request(path, { method: "DELETE", headers }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function put(
  path: string,
  headers: Record<string, string>,
  body?: unknown
) {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    {
      method: "PUT",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    },
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function sampleDeveloper(overrides?: { id?: string; name?: string }) {
  return {
    id: overrides?.id ?? "dev-developer",
    type: "user",
    name: overrides?.name ?? "Dev Developer",
    URL: "https://example.com"
  };
}

describe("Extensions API v2", () => {
  describe("POST /submissions", () => {
    it("requires auth", async () => {
      const res = await post(
        "/extensions/v2/submissions",
        {
          "Content-Type": "application/json"
        },
        samplePayload()
      );
      expect(res.status).toBe(401);
    });

    it("rejects an invalid payload", async () => {
      const headers = await authHeaders("user-1");
      const res = await post("/extensions/v2/submissions", headers, {
        developer: {},
        extension: {}
      });
      expect(res.status).toBe(422);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects profile fields (avatar_url/contact_email) on a submission's developer", async () => {
      seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      const payload = samplePayload();
      const res = await post("/extensions/v2/submissions", headers, {
        ...payload,
        developer: {
          ...payload.developer,
          avatar_url: "https://example.com/should-not-be-accepted.png"
        }
      });

      expect(res.status).toBe(422);
      expect(tables.extension_submissions.size).toBe(0);
    });

    it("creates a pending submission for a brand-new extension under an existing developer", async () => {
      seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload()
      );

      expect(res.status).toBe(201);
      const data = (await res.json()) as {
        result: { id: string; status: string };
      };
      expect(data.result.status).toBe("pending");
      expect(tables.extension_submissions.size).toBe(1);

      const stored = [...tables.extension_submissions.values()][0];
      expect(stored.extension_id).toBeNull();
      expect(stored.submitted_by).toBe("user-1");
    });

    it("rejects editing an extension not owned by the caller", async () => {
      seedOwnedExtension();
      const headers = await authHeaders("intruder");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({
          extensionId: "existing-ext",
          developerId: "owner-developer"
        })
      );

      expect(res.status).toBe(403);
      expect(tables.extension_submissions.size).toBe(0);
    });

    it("allows editing an extension owned by the caller", async () => {
      seedOwnedExtension();
      const headers = await authHeaders("owner-1");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({
          extensionId: "existing-ext",
          developerId: "owner-developer"
        })
      );

      expect(res.status).toBe(201);
      const stored = [...tables.extension_submissions.values()][0];
      expect(stored.extension_id).toBe("existing-ext");
    });

    it("rejects claiming a developer already owned by someone else", async () => {
      seedOwnedExtension();
      const headers = await authHeaders("intruder");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({
          extensionId: "another-new-ext",
          developerId: "owner-developer"
        })
      );

      expect(res.status).toBe(403);
    });

    it("rejects naming a developer id that doesn't exist at all", async () => {
      const headers = await authHeaders("user-1");

      const res = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({ developerId: "no-such-developer" })
      );

      expect(res.status).toBe(403);
      expect(tables.extension_submissions.size).toBe(0);
    });

    it("bounds payload size and the number of releases", async () => {
      seedDeveloper("new-developer", "user-1");
      const payload = samplePayload();
      const oversized = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        {
          ...payload,
          extension: { ...payload.extension, readme: "x".repeat(100_001) }
        }
      );
      expect(oversized.status).toBe(422);

      const unknownExtensionField = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        {
          ...payload,
          extension: {
            ...payload.extension,
            padding: "x"
          }
        }
      );
      expect(unknownExtensionField.status).toBe(422);
      const unknownExtensionBody = (await unknownExtensionField.json()) as {
        error: { details: Array<{ code: string; path: PropertyKey[] }> };
      };
      expect(unknownExtensionBody.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            path: ["extension"]
          })
        ])
      );

      const unknownReleaseField = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        {
          ...payload,
          extension: {
            ...payload.extension,
            releases: [
              {
                ...payload.extension.releases[0],
                padding: "x"
              }
            ]
          }
        }
      );
      expect(unknownReleaseField.status).toBe(422);
      const unknownReleaseBody = (await unknownReleaseField.json()) as {
        error: { details: Array<{ code: string; path: PropertyKey[] }> };
      };
      expect(unknownReleaseBody.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            path: ["extension", "releases", 0]
          })
        ])
      );

      const tooManyReleases = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        {
          ...payload,
          extension: {
            ...payload.extension,
            releases: Array.from(
              { length: 101 },
              () => payload.extension.releases[0]
            )
          }
        }
      );
      expect(tooManyReleases.status).toBe(422);
    });

    it("preserves compatibility with stored slug ids over 100 characters", async () => {
      const developerId = "d".repeat(120);
      const extensionId = "e".repeat(120);
      seedDeveloper(developerId, "user-1");

      const res = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload({ developerId, extensionId })
      );

      expect(res.status).toBe(201);
    });

    it("rejects duplicate pending targets and caps each user's backlog", async () => {
      seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      expect(
        (await post("/extensions/v2/submissions", headers, samplePayload()))
          .status
      ).toBe(201);
      expect(
        (await post("/extensions/v2/submissions", headers, samplePayload()))
          .status
      ).toBe(409);

      seedDeveloper("other-developer", "user-2");
      expect(
        (
          await post(
            "/extensions/v2/submissions",
            await authHeaders("user-2"),
            samplePayload({ developerId: "other-developer" })
          )
        ).status
      ).toBe(409);

      for (let index = 1; index < 10; index++) {
        const result = await post(
          "/extensions/v2/submissions",
          headers,
          samplePayload({ extensionId: `new-ext-${index}` })
        );
        expect(result.status).toBe(201);
      }
      const overLimit = await post(
        "/extensions/v2/submissions",
        headers,
        samplePayload({ extensionId: "new-ext-over-limit" })
      );
      expect(overLimit.status).toBe(409);
      expect(tables.extension_submissions.size).toBe(10);
    });
  });

  describe("GET /submissions/mine", () => {
    it("returns only the caller's own submissions", async () => {
      seedDeveloper("developer-a", "user-1");
      seedDeveloper("developer-b", "user-2");
      await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload({ extensionId: "ext-a", developerId: "developer-a" })
      );
      await post(
        "/extensions/v2/submissions",
        await authHeaders("user-2"),
        samplePayload({ extensionId: "ext-b", developerId: "developer-b" })
      );

      const res = await get(
        "/extensions/v2/submissions/mine",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: Array<{ submitted_by: string }>;
      };
      expect(data.result).toHaveLength(1);
      expect(data.result[0].submitted_by).toBe("user-1");
    });

    it("requires auth", async () => {
      const res = await get("/extensions/v2/submissions/mine", {});
      expect(res.status).toBe(401);
    });

    it("paginates deterministically with an opaque cursor", async () => {
      seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      for (const extensionId of ["page-a", "page-b", "page-c"]) {
        expect(
          (
            await post(
              "/extensions/v2/submissions",
              headers,
              samplePayload({ extensionId })
            )
          ).status
        ).toBe(201);
      }

      const first = await get(
        "/extensions/v2/submissions/mine?limit=2",
        headers
      );
      const firstBody = (await first.json()) as {
        result: unknown[];
        pagination: { has_more: boolean; next_cursor: string };
      };
      expect(firstBody.result).toHaveLength(2);
      expect(firstBody.pagination.has_more).toBe(true);

      const second = await get(
        `/extensions/v2/submissions/mine?limit=2&cursor=${encodeURIComponent(firstBody.pagination.next_cursor)}`,
        headers
      );
      const secondBody = (await second.json()) as {
        result: unknown[];
        pagination: { has_more: boolean; next_cursor: null };
      };
      expect(secondBody.result).toHaveLength(1);
      expect(secondBody.pagination).toEqual({
        has_more: false,
        next_cursor: null
      });
    });
  });

  describe("GET /submissions/queue", () => {
    it("requires moderator access", async () => {
      const res = await get(
        "/extensions/v2/submissions/queue",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(403);
    });

    it("returns pending submissions for a moderator", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedDeveloper("new-developer", "user-1");
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
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedDeveloper("new-developer", "user-1");
      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      tables.raceOwnerChangeOnSubmissionApprovalTo = "user-2";
      const approved = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(409);
      expect(tables.extension_submissions.get(result.id)?.status).toBe(
        "pending"
      );
      expect(tables.extensions.size).toBe(0);
    });

    it("reverts to pending if the write-through fails after a successful claim", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedDeveloper("new-developer", "user-1");

      const created = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload()
      );
      const { result } = (await created.json()) as { result: { id: string } };

      tables.forceExtensionWriteFailure = true;
      const approved = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(approved.status).toBe(500);
      expect(tables.extensions.size).toBe(0);

      const stored = tables.extension_submissions.get(result.id);
      expect(stored?.status).toBe("pending");

      // Recovers cleanly once the underlying failure is gone.
      tables.forceExtensionWriteFailure = false;
      const retried = await post(
        `/extensions/v2/submissions/${result.id}/approve`,
        await authHeaders("mod-1"),
        {}
      );
      expect(retried.status).toBe(200);
      expect(tables.extensions.size).toBe(1);
    });

    it("approves a submission and it becomes visible via the v1 read path", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedDeveloper("new-developer", "user-1");

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
      seedDeveloper("new-developer", "user-1");
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
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedDeveloper("new-developer", "user-1");
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
      expect(tables.extensions.size).toBe(1);
    });

    it("updates the existing row instead of duplicating it when an edit's id differs only by case", async () => {
      tables.developers.set("owner-developer", {
        id: "owner-developer",
        type: "user",
        name: "Owner",
        url: null,
        owner_user_id: "owner-1"
      });
      // Legacy v1 data can have mixed-case ids; v2 submissions must be lowercase.
      tables.extensions.set("Existing-Ext", {
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
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

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

      expect(tables.extensions.size).toBe(1);
      const stored = tables.extensions.get("Existing-Ext");
      expect(stored?.name).toBe("New Extension");
    });

    it("requires a review_note to reject", async () => {
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedDeveloper("new-developer", "user-1");
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
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      seedDeveloper("new-developer", "user-1");
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
      expect(tables.extensions.size).toBe(0);
    });
  });

  describe("PUT /developers/me", () => {
    it("creates a new developer profile, unapproved", async () => {
      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: { approved: boolean } };
      expect(data.result.approved).toBe(false);

      const stored = tables.developers.get("dev-developer");
      expect(stored).toBeDefined();
      expect(stored?.approved_at).toBeNull();
    });

    it("updates an existing profile, still unapproved", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper({ name: "Renamed Developer" })
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: { name: string; approved: boolean };
      };
      expect(data.result.name).toBe("Renamed Developer");
      expect(data.result.approved).toBe(false);
      expect(tables.developers.get("dev-developer")?.name).toBe(
        "Renamed Developer"
      );
    });

    it("only lets one of two concurrent first-time profile creations by the same caller win", async () => {
      const headers = await authHeaders("user-1");
      const [resA, resB] = await Promise.all([
        put(
          "/extensions/v2/developers/me",
          headers,
          sampleDeveloper({ id: "developer-a" })
        ),
        put(
          "/extensions/v2/developers/me",
          headers,
          sampleDeveloper({ id: "developer-b" })
        )
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const ownedDevelopers = [...tables.developers.values()].filter(
        (a) => a.owner_user_id === "user-1"
      );
      expect(ownedDevelopers).toHaveLength(1);
    });

    it("rejects an id that already belongs to someone else", async () => {
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
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("DEVELOPER_ID_TAKEN");
    });

    it("rejects changing the id on an existing profile", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper({ id: "different-id" })
      );

      expect(res.status).toBe(409);
    });

    it("verifies a new profile when the creator's linked GitHub org matches the id", async () => {
      mockGithubEntity("Organization");
      tables.users.set("user-1", {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["acme-org"])
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { id: "acme-org", type: "organization", name: "Acme Org" }
      );

      expect(res.status).toBe(200);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBe(true);
    });

    it("blocks creating a profile whose id matches a real GitHub org/user the creator doesn't control", async () => {
      mockGithubEntity("Organization");
      tables.users.set("user-1", {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["some-other-org"])
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { id: "acme-org", type: "organization", name: "Acme Org" }
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GITHUB_MISMATCH");
      expect(tables.developers.has("acme-org")).toBe(false);
    });

    it("blocks creating a profile whose id matches a real GitHub entity of the opposite type", async () => {
      mockGithubEntity("Organization");
      tables.users.set("user-1", {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["acme-org"])
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { id: "acme-org", type: "user", name: "Acme Org" }
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GITHUB_MISMATCH");
      expect(tables.developers.has("acme-org")).toBe(false);
    });

    it("falls back to unverified creation when the creator has no linked GitHub identity", async () => {
      mockGithubEntity("Organization");
      // No row in tables.users for user-1 — never linked GitHub.

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { id: "acme-org", type: "organization", name: "Acme Org" }
      );

      expect(res.status).toBe(200);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBeUndefined();
    });

    it("fails creation rather than falling back to unverified when the caller's GitHub identity lookup errors", async () => {
      mockGithubEntity("Organization");
      tables.forceGithubIdentityLookupFailure = true;

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { id: "acme-org", type: "organization", name: "Acme Org" }
      );

      expect(res.status).toBe(500);
      expect(tables.developers.has("acme-org")).toBe(false);
    });

    it.each(["claims", "unapproved"])(
      "rejects the reserved id %s",
      async (id) => {
        const res = await put(
          "/extensions/v2/developers/me",
          await authHeaders("user-1"),
          sampleDeveloper({ id })
        );

        expect(res.status).toBe(422);
      }
    );

    it("clears approval when an approved profile is edited", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      const approved = await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 1 }
      );
      expect(approved.status).toBe(200);
      const approvedBody = (await approved.json()) as {
        result: { approved: boolean };
      };
      expect(approvedBody.result.approved).toBe(true);

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper({ name: "Edited Again" })
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { result: { approved: boolean } };
      expect(data.result.approved).toBe(false);
    });

    it("does not update a profile after ownership changes mid-request", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      tables.raceOwnerChangeOnProfileUpdateTo = "user-2";

      const raced = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper({ name: "Former owner write" })
      );

      expect(raced.status).toBe(409);
      expect(tables.developers.get("dev-developer")?.name).toBe(
        "Dev Developer"
      );
      expect(tables.developers.get("dev-developer")?.owner_user_id).toBe(
        "user-2"
      );
      expect(
        [...tables.developer_history.values()].filter(
          (row) => row.developer_id === "dev-developer"
        )
      ).toHaveLength(1);
    });

    it("round-trips avatar_url and contact_email", async () => {
      const headers = await authHeaders("user-1");
      const res = await put("/extensions/v2/developers/me", headers, {
        ...sampleDeveloper(),
        avatar_url: "https://example.com/avatar.png",
        contact_email: "dev@example.com"
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: {
          avatar_url: string;
          contact_email: string;
        };
      };
      expect(data.result.avatar_url).toBe("https://example.com/avatar.png");
      expect(data.result.contact_email).toBe("dev@example.com");

      const stored = tables.developers.get("dev-developer");
      expect(stored?.avatar_url).toBe("https://example.com/avatar.png");
      expect(stored?.contact_email).toBe("dev@example.com");
    });

    it("updates avatar_url and contact_email on an existing profile", async () => {
      const headers = await authHeaders("user-1");
      await put("/extensions/v2/developers/me", headers, {
        ...sampleDeveloper(),
        avatar_url: "https://example.com/old.png",
        contact_email: "old@example.com"
      });

      const res = await put("/extensions/v2/developers/me", headers, {
        ...sampleDeveloper(),
        avatar_url: "https://example.com/new.png",
        contact_email: "new@example.com"
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: {
          avatar_url: string;
          contact_email: string;
        };
      };
      expect(data.result.avatar_url).toBe("https://example.com/new.png");
      expect(data.result.contact_email).toBe("new@example.com");

      const stored = tables.developers.get("dev-developer");
      expect(stored?.avatar_url).toBe("https://example.com/new.png");
      expect(stored?.contact_email).toBe("new@example.com");
    });

    it("accepts a payload without avatar_url or contact_email", async () => {
      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: {
          avatar_url?: string;
          contact_email?: string;
        };
      };
      expect(data.result.avatar_url).toBeUndefined();
      expect(data.result.contact_email).toBeUndefined();
    });
  });

  describe("DELETE /developers/me", () => {
    it("deletes a profile with no extensions or pending submissions", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { id: string; deleted: boolean };
      };
      expect(body.result).toEqual({ id: "dev-developer", deleted: true });

      const getRes = await get("/extensions/v2/developers/dev-developer", {});
      expect(getRes.status).toBe(404);
    });

    it("404s for a caller with no developer profile", async () => {
      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("no-profile-user")
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("409s when the profile still has published extensions", async () => {
      seedOwnedExtension();

      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("owner-1")
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toContain("1 published extension(s)");
    });

    it("409s when a submission is pending", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      tables.extension_submissions.set("sub-1", {
        id: "sub-1",
        extension_id: null,
        developer_id: "dev-developer",
        submitted_by: "user-1",
        status: "pending",
        payload: JSON.stringify(samplePayload()),
        reviewer_id: null,
        review_note: null,
        created_at: new Date().toISOString(),
        reviewed_at: null
      });

      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("CONFLICT");
    });

    it("removes transfer tokens and claims but keeps history", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      tables.developer_claims.set("claim-1", {
        id: "claim-1",
        developer_id: "dev-developer",
        claimant_id: "user-2",
        status: "rejected",
        note: null,
        review_note: "no",
        reviewer_id: "mod-1",
        created_at: new Date().toISOString(),
        reviewed_at: new Date().toISOString()
      });

      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);

      expect(
        [...tables.developer_transfers.values()].filter(
          (r) => r.developer_id === "dev-developer"
        )
      ).toHaveLength(0);
      expect(
        [...tables.developer_claims.values()].filter(
          (r) => r.developer_id === "dev-developer"
        )
      ).toHaveLength(0);
      expect(
        [...tables.developer_history.values()].filter(
          (r) => r.developer_id === "dev-developer"
        ).length
      ).toBeGreaterThan(0);
    });

    it("refuses to delete if ownership moves away between the lookup and the delete", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      tables.users.set("user-2", { id: "user-2" });
      // Simulates a transfer/claim landing in the window between deleteOwn's
      // initial "find my profile" lookup and its guarded delete — the
      // delete must re-check ownership at that point, not trust the lookup.
      tables.raceOwnerChangeTo = "user-2";

      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(404);

      const stillThere = await get(
        "/extensions/v2/developers/dev-developer",
        {}
      );
      expect(stillThere.status).toBe(200);
      const body = (await stillThere.json()) as { result: { id: string } };
      expect(body.result.id).toBe("dev-developer");
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
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

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
    it("approves a developer and removes it from the unapproved list", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

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
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

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
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
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
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

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
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

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
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

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

      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      const history = await get(
        "/extensions/v2/developers/dev-developer/history",
        await authHeaders("mod-1")
      );
      const data = (await history.json()) as { result: unknown[] };
      expect(data.result).toHaveLength(1);
    });
  });

  describe("developer transfers", () => {
    it("does not accept transfer capabilities in URL paths", async () => {
      const res = await post(
        "/extensions/v2/developers/transfers/secret-token/accept",
        await authHeaders("user-2")
      );
      expect(res.status).toBe(404);
    });

    it("initiating a second transfer revokes the first token", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const first = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      expect(first.status).toBe(200);
      const firstToken = ((await first.json()) as { result: { token: string } })
        .result.token;

      const second = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      expect(second.status).toBe(200);

      const acceptFirst = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token: firstToken }
      );
      expect(acceptFirst.status).toBe(404);
    });

    it("accepts a valid token, transferring ownership and clearing approval", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 1 }
      );

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(200);
      const accepted = (await accept.json()) as {
        result: { id: string; approved: boolean };
      };
      expect(accepted.result.id).toBe("dev-developer");
      expect(accepted.result.approved).toBe(false);
      expect(tables.developers.get("dev-developer")?.owner_user_id).toBe(
        "user-2"
      );

      const acceptAgain = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-3"),
        { token }
      );
      expect(acceptAgain.status).toBe(404);
      expect(tables.developers.get("dev-developer")?.owner_user_id).toBe(
        "user-2"
      );
    });

    it("does not let replaying an already-used token reassign ownership away from a later owner", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const initiate1 = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token1 = ((await initiate1.json()) as { result: { token: string } })
        .result.token;

      const accept1 = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token: token1 }
      );
      expect(accept1.status).toBe(200);
      expect(tables.developers.get("dev-developer")?.owner_user_id).toBe(
        "user-2"
      );

      // dev-developer is legitimately handed off again, to a third user.
      const initiate2 = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-2")
      );
      const token2 = ((await initiate2.json()) as { result: { token: string } })
        .result.token;
      const accept2 = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-3"),
        { token: token2 }
      );
      expect(accept2.status).toBe(200);
      expect(tables.developers.get("dev-developer")?.owner_user_id).toBe(
        "user-3"
      );

      // Replaying the *first* (already-used) token, by the same user who
      // originally accepted it, must not silently reassign ownership back.
      const replay = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token: token1 }
      );
      expect(replay.status).toBe(404);
      expect(tables.developers.get("dev-developer")?.owner_user_id).toBe(
        "user-3"
      );
    });

    it("rejects an expired token", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      for (const transfer of tables.developer_transfers.values()) {
        transfer.expires_at = "2000-01-01 00:00:00";
      }

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(404);
    });

    it("rejects a revoked token", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      const revoke = await post(
        "/extensions/v2/developers/dev-developer/transfer/revoke",
        await authHeaders("user-1")
      );
      expect(revoke.status).toBe(200);

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(404);
    });

    it("rejects acceptance by a user who already owns a different profile", async () => {
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

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-2"),
        { token }
      );
      expect(accept.status).toBe(409);
      expect(tables.developers.get("dev-developer")?.owner_user_id).toBe(
        "user-1"
      );
    });

    it("rejects the current owner accepting their own transfer link", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const initiate = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );
      const token = ((await initiate.json()) as { result: { token: string } })
        .result.token;

      const accept = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-1"),
        { token }
      );
      expect(accept.status).toBe(409);
      expect(tables.developers.get("dev-developer")?.owner_user_id).toBe(
        "user-1"
      );
    });

    it("blocks a non-owner from initiating a transfer", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("intruder")
      );
      expect(res.status).toBe(403);
    });

    it("blocks a non-owner from revoking a transfer", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      await post(
        "/extensions/v2/developers/dev-developer/transfer",
        await authHeaders("user-1")
      );

      const res = await post(
        "/extensions/v2/developers/dev-developer/transfer/revoke",
        await authHeaders("intruder")
      );
      expect(res.status).toBe(403);
    });
  });

  describe("developer claims", () => {
    it("lets a user claim an unowned developer, visible to the claimant and moderators", async () => {
      seedUnownedDeveloper("legacy-developer");

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        { note: "I'm the maintainer, see github.com/x" }
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as { result: { id: string } };

      const mine = await get(
        "/extensions/v2/developers/claims/mine",
        await authHeaders("user-1")
      );
      expect(mine.status).toBe(200);
      const mineData = (await mine.json()) as {
        result: Array<{ id: string; status: string }>;
      };
      expect(mineData.result.map((c) => c.id)).toEqual([created.result.id]);
      expect(mineData.result[0].status).toBe("pending");

      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });
      const pending = await get(
        "/extensions/v2/developers/claims",
        await authHeaders("mod-1")
      );
      expect(pending.status).toBe(200);
      const pendingData = (await pending.json()) as {
        result: Array<{ id: string; developer_name: string }>;
      };
      expect(pendingData.result.map((c) => c.id)).toEqual([created.result.id]);
      expect(pendingData.result[0].developer_name).toBe("Legacy Developer");
    });

    it("rejects claiming a developer that already has an owner", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await post(
        "/extensions/v2/developers/dev-developer/claim",
        await authHeaders("user-2"),
        {}
      );
      expect(res.status).toBe(409);
    });

    it("does not create a duplicate row for a second claim while one is already pending", async () => {
      seedUnownedDeveloper("legacy-developer");

      const first = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(first.status).toBe(201);

      const second = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(second.status).toBe(409);
      expect(tables.developer_claims.size).toBe(1);
    });

    it("does not re-check GitHub when replaying an already-pending claim", async () => {
      seedUnownedDeveloper("legacy-developer");

      await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const callsAfterFirst = vi.mocked(ghRequest).mock.calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      const second = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );

      expect(second.status).toBe(409);
      expect(vi.mocked(ghRequest).mock.calls.length).toBe(callsAfterFirst);
    });

    it("still verifies GitHub ownership on a retry after the prior claim was rejected", async () => {
      seedUnownedDeveloper("legacy-developer");
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

      const first = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await first.json()) as { result: { id: string } })
        .result.id;
      await post(
        `/extensions/v2/developers/claims/${claimId}/reject`,
        await authHeaders("mod-1"),
        { review_note: "Not enough evidence" }
      );

      // Retrying now, with a GitHub identity that doesn't match: this must
      // still be blocked rather than silently creating an unverified claim
      // just because the prior (now-rejected) row cleared the pending guard.
      mockGithubEntity("Organization");
      tables.users.set("user-1", {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["some-other-org"])
      });

      const claimCountBefore = tables.developer_claims.size;
      const retry = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );

      expect(retry.status).toBe(403);
      const body = (await retry.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GITHUB_MISMATCH");
      expect(tables.developer_claims.size).toBe(claimCountBefore);
    });

    it("rejects a claim from a user who already owns a different profile", async () => {
      seedUnownedDeveloper("legacy-developer");
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(409);
    });

    it("approving a claim transfers ownership and auto-rejects competing claims", async () => {
      seedUnownedDeveloper("legacy-developer");
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

      const claim1 = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claim1Id = ((await claim1.json()) as { result: { id: string } })
        .result.id;

      const claim2 = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-2"),
        {}
      );
      const claim2Id = ((await claim2.json()) as { result: { id: string } })
        .result.id;

      const approve = await post(
        `/extensions/v2/developers/claims/${claim1Id}/approve`,
        await authHeaders("mod-1")
      );
      expect(approve.status).toBe(200);
      const approved = (await approve.json()) as {
        result: { id: string; approved: boolean };
      };
      expect(approved.result.id).toBe("legacy-developer");
      expect(approved.result.approved).toBe(false);
      expect(tables.developers.get("legacy-developer")?.owner_user_id).toBe(
        "user-1"
      );

      const rejectedClaim = tables.developer_claims.get(claim2Id);
      expect(rejectedClaim?.status).toBe("rejected");
      expect(rejectedClaim?.review_note).toBe(
        "Another claim on this profile was approved"
      );
    });

    it("lets a moderator reject a claim with a review note, leaving the developer unowned", async () => {
      seedUnownedDeveloper("legacy-developer");
      tables.users.set("mod-1", { id: "mod-1", is_moderator: 1 });

      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;

      const reject = await post(
        `/extensions/v2/developers/claims/${claimId}/reject`,
        await authHeaders("mod-1"),
        { review_note: "Not enough evidence of maintainership" }
      );
      expect(reject.status).toBe(200);
      const rejected = (await reject.json()) as {
        result: { status: string; review_note?: string };
      };
      expect(rejected.result.status).toBe("rejected");
      expect(rejected.result.review_note).toBe(
        "Not enough evidence of maintainership"
      );
      expect(
        tables.developers.get("legacy-developer")?.owner_user_id
      ).toBeNull();
    });

    it("verifies a claim when the claimant's linked GitHub org matches the developer id", async () => {
      tables.developers.set("legacy-developer", {
        id: "legacy-developer",
        type: "organization",
        name: "Legacy Developer",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("Organization");
      tables.users.set("user-1", {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["legacy-developer"])
      });

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBe(true);
    });

    it("verifies a claim when the claimant's linked GitHub login matches a user-type developer id", async () => {
      tables.developers.set("legacy-user", {
        id: "legacy-user",
        type: "user",
        name: "Legacy User",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("User");
      tables.users.set("user-1", {
        id: "user-1",
        github_login: "legacy-user",
        github_orgs: JSON.stringify([])
      });

      const res = await post(
        "/extensions/v2/developers/legacy-user/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBe(true);
    });

    it("blocks a claim outright when the claimant's linked GitHub identity doesn't match", async () => {
      tables.developers.set("legacy-developer", {
        id: "legacy-developer",
        type: "organization",
        name: "Legacy Developer",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("Organization");
      tables.users.set("user-1", {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["some-other-org"])
      });

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GITHUB_MISMATCH");
      expect(tables.developer_claims.size).toBe(0);
    });

    it("falls back to unverified manual review when the claimant has no linked GitHub identity", async () => {
      seedUnownedDeveloper("legacy-developer"); // type: "user"
      mockGithubEntity("User");
      // No row in tables.users for user-1 — never linked GitHub.

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBeUndefined();
    });

    it("falls back to unverified manual review when no matching GitHub org/user exists for the id", async () => {
      seedUnownedDeveloper("legacy-developer");
      mockGithubEntityNotFound();

      const res = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBeUndefined();
    });

    it("blocks non-moderators from the claims queue and review routes", async () => {
      seedUnownedDeveloper("legacy-developer");
      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;

      const queue = await get(
        "/extensions/v2/developers/claims",
        await authHeaders("intruder")
      );
      expect(queue.status).toBe(403);

      const approve = await post(
        `/extensions/v2/developers/claims/${claimId}/approve`,
        await authHeaders("intruder")
      );
      expect(approve.status).toBe(403);

      const reject = await post(
        `/extensions/v2/developers/claims/${claimId}/reject`,
        await authHeaders("intruder"),
        { review_note: "no" }
      );
      expect(reject.status).toBe(403);
    });
  });

  describe("GET /developers/{id}", () => {
    it("returns a developer's public profile without contact_email, unauthenticated", async () => {
      tables.developers.set("public-dev", {
        id: "public-dev",
        type: "organization",
        name: "Public Dev",
        url: "https://example.com",
        avatar_url: "https://example.com/avatar.png",
        contact_email: "private@example.com",
        owner_user_id: "user-1",
        approved_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      const res = await get("/extensions/v2/developers/public-dev", {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: Record<string, unknown> };
      expect(body.result).toEqual({
        id: "public-dev",
        type: "organization",
        name: "Public Dev",
        URL: "https://example.com",
        avatar_url: "https://example.com/avatar.png",
        approved: true
      });
      expect(body.result.contact_email).toBeUndefined();
    });

    it("404s for an unknown developer", async () => {
      const res = await get("/extensions/v2/developers/no-such-developer", {});
      expect(res.status).toBe(404);
    });
  });

  describe("GET /extensions", () => {
    it("lists published extensions with the developer embedded", async () => {
      seedOwnedExtension();

      const res = await get("/extensions/v2/extensions", {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: Array<{ id: string; developer: { id: string } }>;
      };
      expect(body.result).toHaveLength(1);
      expect(body.result[0].id).toBe("existing-ext");
      expect(body.result[0].developer.id).toBe("owner-developer");
    });

    it("filters by type", async () => {
      seedOwnedExtension();

      const matching = await get("/extensions/v2/extensions?type=mod", {});
      const matchingBody = (await matching.json()) as { result: unknown[] };
      expect(matchingBody.result).toHaveLength(1);

      const nonMatching = await get("/extensions/v2/extensions?type=theme", {});
      const nonMatchingBody = (await nonMatching.json()) as {
        result: unknown[];
      };
      expect(nonMatchingBody.result).toHaveLength(0);
    });

    it("422s on an invalid type filter", async () => {
      const res = await get("/extensions/v2/extensions?type=not-a-type", {});
      expect(res.status).toBe(422);
    });

    it("filters by developer_id", async () => {
      seedOwnedExtension();

      const matching = await get(
        "/extensions/v2/extensions?developer_id=owner-developer",
        {}
      );
      const matchingBody = (await matching.json()) as { result: unknown[] };
      expect(matchingBody.result).toHaveLength(1);

      const nonMatching = await get(
        "/extensions/v2/extensions?developer_id=someone-else",
        {}
      );
      const nonMatchingBody = (await nonMatching.json()) as {
        result: unknown[];
      };
      expect(nonMatchingBody.result).toHaveLength(0);
    });
  });

  describe("GET /extensions/{id}", () => {
    it("gets a single extension, case-insensitively", async () => {
      seedOwnedExtension();

      const res = await get("/extensions/v2/extensions/EXISTING-EXT", {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { id: string; developer: { name: string; approved: boolean } };
      };
      expect(body.result.id).toBe("existing-ext");
      expect(body.result.developer.name).toBe("Owner");
      expect(body.result.developer.approved).toBe(false);
    });

    it("404s for an unknown extension", async () => {
      const res = await get("/extensions/v2/extensions/no-such-extension", {});
      expect(res.status).toBe(404);
    });

    it("still returns a usable developer.id when the developer row is missing", async () => {
      // author_id isn't a hard FK (0001_add_v2_tables.sql), so this can
      // happen without any application bug — the embedded developer must
      // still satisfy the schema (id: string) rather than surface a null.
      tables.extensions.set("orphaned-ext", {
        id: "orphaned-ext",
        type: "mod",
        author_id: "no-such-developer",
        name: "Orphaned",
        description: "d",
        releases: "[]",
        website: "https://e.com",
        license: '{"name":"MIT"}',
        icon_url: null,
        readme: "r",
        source: '{"type":"github","repo":"example/orphaned"}',
        version: "1.0.0",
        download_url: "https://e.com/d.zip"
      });

      const res = await get("/extensions/v2/extensions/orphaned-ext", {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { developer: unknown } };
      expect(body.result.developer).toEqual({
        id: "no-such-developer",
        type: "user",
        name: "",
        approved: false
      });
    });
  });

  describe("OpenAPI docs", () => {
    it("serves a generated OpenAPI document", async () => {
      const res = await get("/extensions/v2/openapi.json", {});
      expect(res.status).toBe(200);
      const spec = (await res.json()) as {
        openapi: string;
        paths: Record<string, unknown>;
      };
      expect(spec.openapi).toBe("3.1.0");
      expect(Object.keys(spec.paths)).toEqual(
        expect.arrayContaining([
          "/extensions",
          "/extensions/{id}",
          "/submissions",
          "/submissions/mine",
          "/submissions/queue",
          "/submissions/{id}/approve",
          "/submissions/{id}/reject",
          "/developers/me",
          "/developers/{id}",
          "/developers/unapproved",
          "/developers/{id}/approve",
          "/developers/{id}/transfer",
          "/developers/{id}/transfer/revoke",
          "/developers/transfers/accept",
          "/developers/{id}/claim",
          "/developers/claims/mine",
          "/developers/claims",
          "/developers/claims/{id}/approve",
          "/developers/claims/{id}/reject"
        ])
      );
    });

    it("serves the Scalar API reference UI", async () => {
      const res = await get("/extensions/v2/docs", {});
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    });
  });
});
