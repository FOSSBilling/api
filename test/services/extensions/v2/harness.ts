import { beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { request as ghRequest } from "@octokit/request";
import app from "../../../../src/app";
import { signAssertion } from "../../../lib/auth/assertion-helper";
import { MockGitHubRequest } from "../../../utils/test-types";
import { applyTestMigrations } from "../../../utils/apply-migrations";
import {
  resetExtensionsDb,
  ensureUser,
  insertDeveloper,
  insertExtension
} from "./db-fixtures";

// Matches the ASSERTION_SIGNING_SECRET binding configured in vitest.config.ts.
const SECRET = "test-assertion-signing-secret";

// The real D1_EXTENSIONS binding. beforeEach captures it fresh each time and
// afterEach always restores env.DB_EXTENSIONS to this reference, so the
// handful of tests that temporarily wrap it (see db-interceptor.ts) for a
// fault/race injection never leak that wrapper into the next test. Suites
// read it with `import { db }` — an ES module live binding, so they see each
// beforeEach reassignment. They must never assign to it; the tests that
// inject a fault replace env.DB_EXTENSIONS instead, which is what keeps the
// fixtures below running against the unwrapped binding.
export let db: D1Database;

// The default applied in beforeEach: DeveloperClaimsDatabase.claim()'s GitHub
// entity-existence check must never make a real network call. "Not found"
// matches classifyGitHubError's NotFoundError check in
// src/services/extensions/v2/github/verification.ts, which makes claim() fall
// back to the unverified/manual-review path these tests expect. Individual
// tests call mockGithubEntity() to exercise the verified/mismatch paths.
export function mockGithubEntityNotFound(): void {
  (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(async () => {
    throw Object.assign(new Error("Not Found"), { status: 404 });
  });
}

export function mockGithubEntity(
  type: "User" | "Organization",
  blog?: string
): void {
  (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(async () => ({
    data: { type, blog }
  }));
}

function freshProfileCreationRateLimiter(): RateLimit {
  const attempts = new Map<string, number>();
  return {
    async limit({ key }) {
      const next = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, next);
      return { success: next <= 3 };
    }
  };
}

// Every v2 suite calls this once at the top of the file. It owns migrations,
// per-test database reset, the rate-limiter stub, the GitHub mock default,
// and the exported `db` binding the suites import.
export function setupExtensionsV2Tests(): void {
  beforeAll(applyTestMigrations);

  beforeEach(async () => {
    db = env.DB_EXTENSIONS;
    await resetExtensionsDb(db);
    env.PROFILE_CREATION_RATE_LIMITER = freshProfileCreationRateLimiter();
    vi.clearAllMocks();
    mockGithubEntityNotFound();
  });

  afterEach(() => {
    env.DB_EXTENSIONS = db;
  });
}

// In production a caller always already has a `users` row by the time they
// call this API - the shared auth service that mints the assertion is the
// same one that populates it. Real D1 enforces developers.owner_user_id
// (and similar) as a hard FK to users(id), so tests need that precondition
// too; ensureUser() is a no-op if a richer row already exists for this sub.
export async function authHeaders(
  sub: string
): Promise<Record<string, string>> {
  await ensureUser(db, sub);
  const token = await signAssertion(SECRET, { sub });
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

export function samplePayload(overrides?: {
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

export function sampleDeveloper(overrides?: { id?: string; name?: string }) {
  return {
    id: overrides?.id ?? "dev-developer",
    type: "user",
    name: overrides?.name ?? "Dev Developer",
    URL: "https://example.com"
  };
}

// Extension submissions now require the named developer to already exist
// (created via PUT /developers/me) and be owned by the caller.
export async function seedDeveloper(
  id: string,
  ownerUserId: string
): Promise<void> {
  await insertDeveloper(db, {
    id,
    type: "user",
    name: "Developer",
    url: null,
    owner_user_id: ownerUserId
  });
}

export async function seedUnownedDeveloper(
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

export async function seedOwnedExtension(): Promise<void> {
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

export async function post(
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

export async function get(path: string, headers: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await app.request(path, { headers }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function del(path: string, headers: Record<string, string>) {
  const ctx = createExecutionContext();
  const res = await app.request(path, { method: "DELETE", headers }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function put(
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

export async function patch(
  path: string,
  headers: Record<string, string>,
  body?: unknown
) {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    {
      method: "PATCH",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    },
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}
