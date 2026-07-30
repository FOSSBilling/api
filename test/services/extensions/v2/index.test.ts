import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi
} from "vitest";
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
import { signAssertion } from "../../../lib/auth/assertion-helper";
import { MockGitHubRequest } from "../../../utils/test-types";
import { applyTestMigrations } from "../../../utils/apply-migrations";
import { wrapD1WithHook } from "./db-interceptor";
import {
  resetExtensionsDb,
  ensureUser,
  insertUser,
  insertDeveloper,
  insertExtension,
  insertSubmission,
  insertDeveloperClaim,
  getDeveloper,
  hasDeveloper,
  listDevelopers,
  countExtensions,
  getExtension,
  countSubmissions,
  getSubmission,
  listSubmissions,
  countDeveloperClaims,
  getDeveloperClaim,
  listDeveloperTransfers,
  listDeveloperClaims,
  listDeveloperHistory,
  expireAllDeveloperTransfers,
  bumpDeveloperOwnership
} from "./db-fixtures";

function mockGithubEntityNotFound(): void {
  (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(async () => {
    throw Object.assign(new Error("Not Found"), { status: 404 });
  });
}

function mockGithubEntity(
  type: "User" | "Organization",
  blog?: string
): void {
  (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(async () => ({
    data: { type, blog }
  }));
}

// Matches the ASSERTION_SIGNING_SECRET binding configured in vitest.config.ts.
const SECRET = "test-assertion-signing-secret";

// The real D1_EXTENSIONS binding. beforeEach captures it fresh each time and
// afterEach always restores env.DB_EXTENSIONS to this reference, so the
// handful of tests that temporarily wrap it (see db-interceptor.ts) for a
// fault/race injection never leak that wrapper into the next test.
let db: D1Database;

beforeAll(applyTestMigrations);

beforeEach(async () => {
  db = env.DB_EXTENSIONS;
  await resetExtensionsDb(db);
  vi.clearAllMocks();
  mockGithubEntityNotFound();
});

afterEach(() => {
  env.DB_EXTENSIONS = db;
});

// In production a caller always already has a `users` row by the time they
// call this API - the shared auth service that mints the assertion is the
// same one that populates it. Real D1 enforces developers.owner_user_id
// (and similar) as a hard FK to users(id), so tests need that precondition
// too; ensureUser() is a no-op if a richer row already exists for this sub.
async function authHeaders(sub: string): Promise<Record<string, string>> {
  await ensureUser(db, sub);
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
async function seedDeveloper(id: string, ownerUserId: string): Promise<void> {
  await insertDeveloper(db, {
    id,
    type: "user",
    name: "Developer",
    url: null,
    owner_user_id: ownerUserId
  });
}

async function seedUnownedDeveloper(
  id: string,
  name = "Legacy Developer"
): Promise<void> {
  await insertDeveloper(db, {
    id,
    type: "user",
    name,
    url: null,
    owner_user_id: null
  });
}

async function seedOwnedExtension(): Promise<void> {
  await insertDeveloper(db, {
    id: "owner-developer",
    type: "user",
    name: "Owner",
    url: null,
    owner_user_id: "owner-1"
  });
  await insertExtension(db, {
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
      await seedDeveloper("new-developer", "user-1");
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
      expect(await countSubmissions(db)).toBe(0);
    });

    it("creates a pending submission for a brand-new extension under an existing developer", async () => {
      await seedDeveloper("new-developer", "user-1");
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
      expect(await countSubmissions(db)).toBe(1);

      const stored = await getSubmission(db, data.result.id);
      expect(stored?.extension_id).toBeNull();
      expect(stored?.submitted_by).toBe("user-1");
    });

    it("rejects editing an extension not owned by the caller", async () => {
      await seedOwnedExtension();
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
      expect(await countSubmissions(db)).toBe(0);
    });

    it("allows editing an extension owned by the caller", async () => {
      await seedOwnedExtension();
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
      const [stored] = await listSubmissions(db);
      expect(stored.extension_id).toBe("existing-ext");
    });

    it("rejects claiming a developer already owned by someone else", async () => {
      await seedOwnedExtension();
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
      expect(await countSubmissions(db)).toBe(0);
    });

    it("bounds payload size and the number of releases", async () => {
      await seedDeveloper("new-developer", "user-1");
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
      await seedDeveloper(developerId, "user-1");

      const res = await post(
        "/extensions/v2/submissions",
        await authHeaders("user-1"),
        samplePayload({ developerId, extensionId })
      );

      expect(res.status).toBe(201);
    });

    it("rejects duplicate pending targets and caps each user's backlog", async () => {
      await seedDeveloper("new-developer", "user-1");
      const headers = await authHeaders("user-1");
      expect(
        (await post("/extensions/v2/submissions", headers, samplePayload()))
          .status
      ).toBe(201);
      expect(
        (await post("/extensions/v2/submissions", headers, samplePayload()))
          .status
      ).toBe(409);

      await seedDeveloper("other-developer", "user-2");
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
      expect(await countSubmissions(db)).toBe(10);
    });
  });

  describe("GET /submissions/mine", () => {
    it("returns only the caller's own submissions", async () => {
      await seedDeveloper("developer-a", "user-1");
      await seedDeveloper("developer-b", "user-2");
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
      await seedDeveloper("new-developer", "user-1");
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

      const stored = await getDeveloper(db, "dev-developer");
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
      expect((await getDeveloper(db, "dev-developer"))?.name).toBe(
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

      const ownedDevelopers = (await listDevelopers(db)).filter(
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
      await insertUser(db, {
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

    it("verifies the Publisher URL when it matches GitHub's on-file website", async () => {
      mockGithubEntity("Organization", "https://www.acme.example/");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["acme-org"])
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        {
          id: "acme-org",
          type: "organization",
          name: "Acme Org",
          URL: "https://acme.example"
        }
      );

      expect(res.status).toBe(200);
      const created = (await res.json()) as {
        result: { github_org_verified?: boolean; github_url_verified?: boolean };
      };
      expect(created.result.github_org_verified).toBe(true);
      expect(created.result.github_url_verified).toBe(true);
      const stored = await getDeveloper(db, "acme-org");
      expect(stored?.github_url_verified).toBe(1);
    });

    it("doesn't claim a URL match when GitHub's website field differs", async () => {
      mockGithubEntity("Organization", "https://other.example");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["acme-org"])
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        {
          id: "acme-org",
          type: "organization",
          name: "Acme Org",
          URL: "https://acme.example"
        }
      );

      expect(res.status).toBe(200);
      const created = (await res.json()) as {
        result: { github_url_verified?: boolean };
      };
      expect(created.result.github_url_verified).toBeUndefined();
      const stored = await getDeveloper(db, "acme-org");
      expect(stored?.github_url_verified).toBeNull();
    });

    it("matches the Publisher URL to GitHub's website ignoring scheme/www/trailing slash", async () => {
      mockGithubEntity("Organization", "www.acme.example/");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["acme-org"])
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        {
          id: "acme-org",
          type: "organization",
          name: "Acme Org",
          URL: "http://acme.example/"
        }
      );

      const created = (await res.json()) as {
        result: { github_url_verified?: boolean };
      };
      expect(created.result.github_url_verified).toBe(true);
    });

    it("doesn't match Publisher URLs that only differ by port", async () => {
      mockGithubEntity("Organization", "https://acme.example:8443");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["acme-org"])
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        {
          id: "acme-org",
          type: "organization",
          name: "Acme Org",
          URL: "https://acme.example"
        }
      );

      const created = (await res.json()) as {
        result: { github_url_verified?: boolean };
      };
      expect(created.result.github_url_verified).toBeUndefined();
    });

    it("doesn't match Publisher URLs that only differ by path case", async () => {
      mockGithubEntity("Organization", "https://acme.example/Docs");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["acme-org"])
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        {
          id: "acme-org",
          type: "organization",
          name: "Acme Org",
          URL: "https://acme.example/docs"
        }
      );

      const created = (await res.json()) as {
        result: { github_url_verified?: boolean };
      };
      expect(created.result.github_url_verified).toBeUndefined();
    });

    it("blocks creating a profile whose id matches a real GitHub org/user the creator doesn't control", async () => {
      mockGithubEntity("Organization");
      await insertUser(db, {
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
      expect(await hasDeveloper(db, "acme-org")).toBe(false);
    });

    it("blocks creating a profile whose id matches a real GitHub entity of the opposite type", async () => {
      mockGithubEntity("Organization");
      await insertUser(db, {
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
      expect(await hasDeveloper(db, "acme-org")).toBe(false);
    });

    it("falls back to unverified creation when the creator has no linked GitHub identity", async () => {
      mockGithubEntity("Organization");
      // No row in users for user-1 — never linked GitHub.

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
      env.DB_EXTENSIONS = wrapD1WithHook(db, (sql) => {
        if (sql.includes("github_login") && sql.includes("github_orgs")) {
          throw new Error("D1_ERROR: simulated database failure");
        }
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { id: "acme-org", type: "organization", name: "Acme Org" }
      );

      expect(res.status).toBe(500);
      env.DB_EXTENSIONS = db;
      expect(await hasDeveloper(db, "acme-org")).toBe(false);
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
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
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

    it("keeps approval when a GitHub-verified profile is edited", async () => {
      mockGithubEntity("User");
      await insertUser(db, {
        id: "user-1",
        github_login: "dev-developer",
        github_orgs: JSON.stringify([])
      });
      const created = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      const createdBody = (await created.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(createdBody.result.github_org_verified).toBe(true);

      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      const approved = await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 1 }
      );
      expect(approved.status).toBe(200);

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper({ name: "Edited Again" })
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: { approved: boolean; github_org_verified?: boolean };
      };
      expect(data.result.approved).toBe(true);
      expect(data.result.github_org_verified).toBe(true);
    });

    it("clears approval and GitHub verification when the profile type is changed", async () => {
      mockGithubEntity("User");
      await insertUser(db, {
        id: "user-1",
        github_login: "dev-developer",
        github_orgs: JSON.stringify([])
      });
      const created = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );
      const createdBody = (await created.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(createdBody.result.github_org_verified).toBe(true);

      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      await post(
        "/extensions/v2/developers/dev-developer/approve",
        await authHeaders("mod-1"),
        { expected_revision: 1 }
      );

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { ...sampleDeveloper(), type: "organization" }
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: {
          approved: boolean;
          github_org_verified?: boolean;
          github_url_verified?: boolean;
        };
      };
      expect(data.result.approved).toBe(false);
      expect(data.result.github_org_verified).toBeUndefined();
      expect(data.result.github_url_verified).toBeUndefined();
    });

    it("clears github_url_verified when the Publisher URL is edited, but keeps identity verification", async () => {
      mockGithubEntity("User", "https://acme.example");
      await insertUser(db, {
        id: "user-1",
        github_login: "dev-developer",
        github_orgs: JSON.stringify([])
      });
      const created = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { ...sampleDeveloper(), URL: "https://acme.example" }
      );
      const createdBody = (await created.json()) as {
        result: { github_org_verified?: boolean; github_url_verified?: boolean };
      };
      expect(createdBody.result.github_org_verified).toBe(true);
      expect(createdBody.result.github_url_verified).toBe(true);

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { ...sampleDeveloper(), URL: "https://different.example" }
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        result: { github_org_verified?: boolean; github_url_verified?: boolean };
      };
      expect(data.result.github_org_verified).toBe(true);
      expect(data.result.github_url_verified).toBeUndefined();
    });

    it("does not update a profile after ownership changes mid-request", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      // Fires when upsertOwn's existing-profile UPDATE (identified by
      // touching content_revision but not ownership_epoch, which only the
      // ownership-transfer statements touch) is about to run - the DB
      // change lands between existingOwn's read (which still sees user-1
      // as owner) and this guarded write.
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (
          sql.includes("developers") &&
          sql.includes("content_revision") &&
          !sql.includes("ownership_epoch")
        ) {
          await bumpDeveloperOwnership(db, "dev-developer", "user-2");
        }
      });

      const raced = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper({ name: "Former owner write" })
      );
      env.DB_EXTENSIONS = db;

      expect(raced.status).toBe(409);
      expect((await getDeveloper(db, "dev-developer"))?.name).toBe(
        "Dev Developer"
      );
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-2"
      );
      expect(
        (await listDeveloperHistory(db)).filter(
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

      const stored = await getDeveloper(db, "dev-developer");
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

      const stored = await getDeveloper(db, "dev-developer");
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
      await seedOwnedExtension();

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
      await insertSubmission(db, {
        id: "sub-1",
        extension_id: null,
        developer_id: "dev-developer",
        submitted_by: "user-1",
        status: "pending",
        payload: JSON.stringify(samplePayload())
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
      await insertDeveloperClaim(db, {
        id: "claim-1",
        developer_id: "dev-developer",
        claimant_id: "user-2",
        status: "rejected",
        review_note: "no",
        reviewer_id: "mod-1",
        reviewed_at: new Date().toISOString()
      });

      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);

      expect(
        (await listDeveloperTransfers(db)).filter(
          (r) => r.developer_id === "dev-developer"
        )
      ).toHaveLength(0);
      expect(
        (await listDeveloperClaims(db)).filter(
          (r) => r.developer_id === "dev-developer"
        )
      ).toHaveLength(0);
      expect(
        (await listDeveloperHistory(db)).filter(
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
      await insertUser(db, { id: "user-2" });
      // Simulates a transfer/claim landing in the window between deleteOwn's
      // initial "find my profile" lookup and its guarded delete - the
      // delete must re-check ownership at that point, not trust the lookup.
      // deleteTransfersStmt is the first statement in deleteOwn's batch, so
      // firing this before it reproduces the race exactly.
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (
          sql.includes("DELETE FROM") &&
          sql.includes("developer_transfers")
        ) {
          await bumpDeveloperOwnership(db, "dev-developer", "user-2");
        }
      });

      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("user-1")
      );
      env.DB_EXTENSIONS = db;
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

  describe("POST /developers/me/reverify", () => {
    it("re-verifies and refreshes the timestamp when the owner's GitHub org still matches", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: null,
        owner_user_id: "user-1",
        github_org_verified: 1,
        github_verification_note: "Verified: caller's linked GitHub identity matches.",
        github_verified_at: "2020-01-01T00:00:00.000Z"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_org_verified?: boolean; github_verified_at?: string };
      };
      expect(body.result.github_org_verified).toBe(true);
      expect(body.result.github_verified_at).not.toBe("2020-01-01T00:00:00.000Z");
    });

    it("flips to unverified when the owner's GitHub org membership no longer matches", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: null,
        owner_user_id: "user-1",
        github_org_verified: 1,
        github_verification_note: "Verified: caller's linked GitHub identity matches.",
        github_verified_at: "2020-01-01T00:00:00.000Z"
      });
      // No longer a member of dev-developer's org.
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify([])
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_org_verified?: boolean; github_verification_note?: string };
      };
      expect(body.result.github_org_verified).toBe(false);
      expect(body.result.github_verification_note).toBe(
        "No longer verified: caller's linked GitHub identity no longer matches."
      );
    });

    it("verifies for the first time on re-check when the caller now has a matching linked GitHub identity", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: null,
        owner_user_id: "user-1"
        // github_org_verified left null — never checked before (e.g. created
        // before this feature existed, or the token was down at claim time).
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(body.result.github_org_verified).toBe(true);
    });

    it("doesn't check the Publisher URL without ?check_url=true", async () => {
      mockGithubEntity("Organization", "https://acme.example");
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_url_verified?: boolean };
      };
      expect(body.result.github_url_verified).toBeUndefined();
      expect(ghRequest).not.toHaveBeenCalled();
    });

    it("checks the Publisher URL when re-verified with ?check_url=true", async () => {
      mockGithubEntity("Organization", "https://acme.example");
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_url_verified?: boolean };
      };
      expect(body.result.github_url_verified).toBe(true);
    });

    it("rate-limits repeated ?check_url=true calls from the same caller", async () => {
      mockGithubEntity("Organization", "https://acme.example");
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      const first = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      expect(first.status).toBe(200);
      vi.clearAllMocks();

      const second = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      expect(second.status).toBe(429);
      const body = (await second.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
      // The whole point — no GitHub API call for the blocked attempt.
      expect(ghRequest).not.toHaveBeenCalled();
    });

    it("doesn't rate-limit reverify calls that don't use ?check_url", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      const first = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      const second = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it("rate-limits ?check_url=true per caller, not globally", async () => {
      mockGithubEntity("Organization", "https://acme.example");
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1"
      });
      await insertDeveloper(db, {
        id: "other-developer",
        type: "organization",
        name: "Other",
        url: "https://acme.example",
        owner_user_id: "user-2"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });
      await insertUser(db, {
        id: "user-2",
        github_login: "someone-else",
        github_orgs: JSON.stringify(["other-developer"])
      });

      const first = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      const second = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-2")
      );
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
    });

    it("only lets one of two concurrent ?check_url=true requests through", async () => {
      mockGithubEntity("Organization", "https://acme.example");
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      const headers = await authHeaders("user-1");
      const [first, second] = await Promise.all([
        post("/extensions/v2/developers/me/reverify?check_url=true", headers),
        post("/extensions/v2/developers/me/reverify?check_url=true", headers)
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 429]);
    });

    it("does not persist a URL verification computed against a stale URL", async () => {
      mockGithubEntity("Organization", "https://acme.example");
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      // Fires just before reverifyOwn's final write (identified by
      // touching github_verified_at, which only that statement sets) — the
      // Publisher URL changes between the check and the write, same shape
      // as the existing ownership-race test above.
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (sql.includes("developers") && sql.includes("github_verified_at")) {
          await db
            .prepare("UPDATE developers SET url = ? WHERE id = ?")
            .bind("https://different.example", "dev-developer")
            .run();
        }
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      env.DB_EXTENSIONS = db;

      expect(res.status).toBe(409);
      expect((await getDeveloper(db, "dev-developer"))?.github_url_verified).toBe(
        null
      );
      expect((await getDeveloper(db, "dev-developer"))?.url).toBe(
        "https://different.example"
      );
    });

    it("clears a previously-verified Publisher URL when identity no longer matches", async () => {
      mockGithubEntity("Organization", "https://acme.example");
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1",
        github_org_verified: 1,
        github_url_verified: 1
      });
      // No longer a member of dev-developer's org.
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify([])
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_org_verified?: boolean; github_url_verified?: boolean };
      };
      expect(body.result.github_org_verified).toBe(false);
      expect(body.result.github_url_verified).toBeUndefined();
    });

    it("clears a previously-verified Publisher URL when identity no longer matches, even without ?check_url", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1",
        github_org_verified: 1,
        github_url_verified: 1
      });
      // No longer a member of dev-developer's org.
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify([])
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_org_verified?: boolean; github_url_verified?: boolean };
      };
      expect(body.result.github_org_verified).toBe(false);
      expect(body.result.github_url_verified).toBeUndefined();
      // Clearing a stale URL signal on an identity mismatch is a local
      // comparison, same as the identity check itself — no GitHub API call.
      expect(ghRequest).not.toHaveBeenCalled();
    });

    it("doesn't verify the Publisher URL against a GitHub entity of the wrong type", async () => {
      // The stored profile is a "user", but the GitHub entity currently
      // found for this id is an "organization" — matchesClaimant() only
      // compares login/org membership, so this discrepancy has to be
      // caught separately before trusting the entity's blog field.
      mockGithubEntity("Organization", "https://acme.example");
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "user",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "dev-developer",
        github_orgs: JSON.stringify([])
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: {
          github_org_verified?: boolean;
          github_url_verified?: boolean;
          github_verification_note?: string;
        };
      };
      expect(body.result.github_url_verified).toBeUndefined();
      // The same discrepancy that rules out the URL match also undermines
      // the identity match itself — matchesClaimant() alone can't catch
      // this since it never queries GitHub's actual current entity type.
      expect(body.result.github_org_verified).toBe(false);
      expect(body.result.github_verification_note).toBe(
        "No longer verified: GitHub's on-file entity type no longer matches this profile."
      );
    });

    it("preserves an existing Publisher URL verification when the GitHub lookup fails", async () => {
      mockGithubEntityNotFound();
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1",
        github_org_verified: 1,
        github_url_verified: 1
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_url_verified?: boolean };
      };
      expect(body.result.github_url_verified).toBe(true);
    });

    it("treats ?check_url=false the same as omitting it", async () => {
      mockGithubEntity("Organization", "https://acme.example");
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify?check_url=false",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_url_verified?: boolean };
      };
      expect(body.result.github_url_verified).toBeUndefined();
      expect(ghRequest).not.toHaveBeenCalled();
    });

    it("404s when the caller doesn't own a developer profile", async () => {
      const res = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      expect(res.status).toBe(404);
    });

    it("refuses to overwrite verification if ownership moves away between the lookup and the write", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: null,
        owner_user_id: "user-1"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });
      // Simulates a transfer/claim landing in the window between
      // reverifyOwn's initial "find my profile" lookup and its guarded
      // write - the write must re-check ownership at that point, not trust
      // the lookup, or it would write a result computed from the *former*
      // owner's GitHub identity onto the profile after it's changed hands.
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (sql.includes("update") && sql.includes("github_verified_at")) {
          await bumpDeveloperOwnership(db, "dev-developer", "user-2");
        }
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      env.DB_EXTENSIONS = db;
      expect(res.status).toBe(409);

      const developerRow = await getDeveloper(db, "dev-developer");
      expect(developerRow?.owner_user_id).toBe("user-2");
      expect(developerRow?.github_org_verified).toBeNull();
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
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
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
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-2"
      );

      const acceptAgain = await post(
        "/extensions/v2/developers/transfers/accept",
        await authHeaders("user-3"),
        { token }
      );
      expect(acceptAgain.status).toBe(404);
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
        "user-2"
      );
    });

    it("doesn't inherit the previous owner's check_url cooldown after a transfer", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      const usedCooldown = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      expect(usedCooldown.status).toBe(200);

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

      // user-2 has never called check_url themselves — the previous
      // owner's still-active cooldown must not carry over onto them.
      const res = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-2")
      );
      expect(res.status).toBe(200);
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
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
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
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
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
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
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

      await expireAllDeveloperTransfers(db);

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
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
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
      expect((await getDeveloper(db, "dev-developer"))?.owner_user_id).toBe(
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
      await seedUnownedDeveloper("legacy-developer");

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

      await insertUser(db, { id: "mod-1", is_moderator: 1 });
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
      await seedUnownedDeveloper("legacy-developer");

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
      expect(await countDeveloperClaims(db)).toBe(1);
    });

    it("does not re-check GitHub when replaying an already-pending claim", async () => {
      await seedUnownedDeveloper("legacy-developer");

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
      await seedUnownedDeveloper("legacy-developer");
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

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
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["some-other-org"])
      });

      const claimCountBefore = await countDeveloperClaims(db);
      const retry = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );

      expect(retry.status).toBe(403);
      const body = (await retry.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GITHUB_MISMATCH");
      expect(await countDeveloperClaims(db)).toBe(claimCountBefore);
    });

    it("rejects a claim from a user who already owns a different profile", async () => {
      await seedUnownedDeveloper("legacy-developer");
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
      await seedUnownedDeveloper("legacy-developer");
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

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
      expect((await getDeveloper(db, "legacy-developer"))?.owner_user_id).toBe(
        "user-1"
      );

      const rejectedClaim = await getDeveloperClaim(db, claim2Id);
      expect(rejectedClaim?.status).toBe("rejected");
      expect(rejectedClaim?.review_note).toBe(
        "Another claim on this profile was approved"
      );
    });

    it("copies the claim's GitHub verification onto the developer row it transfers ownership to", async () => {
      await insertDeveloper(db, {
        id: "legacy-developer",
        type: "organization",
        name: "Legacy Developer",
        url: null,
        owner_user_id: null
      });
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      mockGithubEntity("Organization");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["legacy-developer"])
      });

      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;
      const claimRow = await getDeveloperClaim(db, claimId);
      expect(claimRow?.github_org_verified).toBe(1);

      const approve = await post(
        `/extensions/v2/developers/claims/${claimId}/approve`,
        await authHeaders("mod-1")
      );
      expect(approve.status).toBe(200);

      const developerRow = await getDeveloper(db, "legacy-developer");
      expect(developerRow?.github_org_verified).toBe(1);
      expect(developerRow?.github_verification_note).toBe(
        "Verified: caller's linked GitHub identity matches."
      );
      expect(developerRow?.github_verified_at).toBe(claimRow?.created_at);
    });

    it("lets a moderator reject a claim with a review note, leaving the developer unowned", async () => {
      await seedUnownedDeveloper("legacy-developer");
      await insertUser(db, { id: "mod-1", is_moderator: 1 });

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
        (await getDeveloper(db, "legacy-developer"))?.owner_user_id
      ).toBeNull();
    });

    it("verifies a claim when the claimant's linked GitHub org matches the developer id", async () => {
      await insertDeveloper(db, {
        id: "legacy-developer",
        type: "organization",
        name: "Legacy Developer",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("Organization");
      await insertUser(db, {
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
      await insertDeveloper(db, {
        id: "legacy-user",
        type: "user",
        name: "Legacy User",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("User");
      await insertUser(db, {
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
      await insertDeveloper(db, {
        id: "legacy-developer",
        type: "organization",
        name: "Legacy Developer",
        url: null,
        owner_user_id: null
      });
      mockGithubEntity("Organization");
      await insertUser(db, {
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
      expect(await countDeveloperClaims(db)).toBe(0);
    });

    it("falls back to unverified manual review when the claimant has no linked GitHub identity", async () => {
      await seedUnownedDeveloper("legacy-developer"); // type: "user"
      mockGithubEntity("User");
      // No row in users for user-1 — never linked GitHub.

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
      await seedUnownedDeveloper("legacy-developer");
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
      await seedUnownedDeveloper("legacy-developer");
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

    it("lets a claimant cancel their own pending claim", async () => {
      await seedUnownedDeveloper("legacy-developer");
      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;

      const cancel = await post(
        `/extensions/v2/developers/claims/${claimId}/cancel`,
        await authHeaders("user-1")
      );
      expect(cancel.status).toBe(200);
      const cancelled = (await cancel.json()) as {
        result: { id: string; cancelled: boolean };
      };
      expect(cancelled.result).toEqual({ id: claimId, cancelled: true });
      expect(await getDeveloperClaim(db, claimId)).toBeNull();
    });

    it("rejects cancelling a claim that belongs to someone else", async () => {
      await seedUnownedDeveloper("legacy-developer");
      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;

      const cancel = await post(
        `/extensions/v2/developers/claims/${claimId}/cancel`,
        await authHeaders("user-2")
      );
      expect(cancel.status).toBe(404);
      expect(await getDeveloperClaim(db, claimId)).not.toBeNull();
    });

    it("rejects cancelling a claim that is no longer pending", async () => {
      await seedUnownedDeveloper("legacy-developer");
      await insertUser(db, { id: "mod-1", is_moderator: 1 });
      const claim = await post(
        "/extensions/v2/developers/legacy-developer/claim",
        await authHeaders("user-1"),
        {}
      );
      const claimId = ((await claim.json()) as { result: { id: string } })
        .result.id;
      await post(
        `/extensions/v2/developers/claims/${claimId}/reject`,
        await authHeaders("mod-1"),
        { review_note: "no" }
      );

      const cancel = await post(
        `/extensions/v2/developers/claims/${claimId}/cancel`,
        await authHeaders("user-1")
      );
      expect(cancel.status).toBe(404);
      expect((await getDeveloperClaim(db, claimId))?.status).toBe("rejected");
    });
  });

  describe("GET /developers/{id}", () => {
    it("returns a developer's public profile without contact_email, unauthenticated", async () => {
      await insertDeveloper(db, {
        id: "public-dev",
        type: "organization",
        name: "Public Dev",
        url: "https://example.com",
        avatar_url: "https://example.com/avatar.png",
        contact_email: "private@example.com",
        owner_user_id: "user-1",
        approved_at: new Date().toISOString()
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
      await seedOwnedExtension();

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
      await seedOwnedExtension();

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
      await seedOwnedExtension();

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
      await seedOwnedExtension();

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

    // A test previously lived here asserting parseExtensionRow's fallback
    // for a "missing developer row" (an extension with an author_id that
    // doesn't exist). It was deleted: extensions.author_id has always been
    // a hard FK to developers(id) in the real schema.sql - the old mock
    // just never enforced it, so that state was never actually reachable
    // in production. The defensive COALESCE/fallback in
    // extensions-database.ts is harmless to keep, just untestable this way
    // against real D1.
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
          "/developers/claims/{id}/cancel",
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
