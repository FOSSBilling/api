import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { request as ghRequest } from "@octokit/request";
import { MockGitHubRequest } from "../../../utils/test-types";
import { wrapD1WithHook } from "./db-interceptor";
import {
  setupExtensionsV2Tests,
  db,
  authHeaders,
  post,
  get,
  put,
  del,
  samplePayload,
  sampleDeveloper,
  seedUnownedDeveloper,
  seedOwnedExtension,
  mockGithubEntity,
  mockGithubEntityNotFound
} from "./harness";
import {
  insertUser,
  insertDeveloper,
  insertSubmission,
  insertDeveloperClaim,
  insertDeveloperTransfer,
  getDeveloper,
  hasDeveloper,
  listDevelopers,
  listDeveloperTransfers,
  listDeveloperClaims,
  listDeveloperHistory,
  bumpDeveloperOwnership
} from "./db-fixtures";

// Hoisted so no v2 suite can make a real GitHub call. harness.ts applies the
// default "not found" behaviour in beforeEach and documents why.
vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

setupExtensionsV2Tests();

describe("Extensions API v2", () => {
  describe("PUT /developers/me", () => {
    it("limits creation attempts per account before GitHub and database writes", async () => {
      mockGithubEntity("Organization");
      const firstHeaders = await authHeaders("rate-limited-account");

      for (const id of ["attempt-one", "attempt-two", "attempt-three"]) {
        const allowed = await put(
          "/extensions/v2/developers/me",
          firstHeaders,
          { id, type: "user", name: id }
        );
        expect(allowed.status).toBe(403);
      }

      const denied = await put("/extensions/v2/developers/me", firstHeaders, {
        id: "attempt-four",
        type: "user",
        name: "Attempt four"
      });
      expect(denied.status).toBe(429);
      expect(denied.headers.get("Retry-After")).toBe("60");
      expect(denied.headers.get("Access-Control-Expose-Headers")).toContain(
        "Retry-After"
      );
      expect(await denied.json()).toMatchObject({
        error: { code: "PROFILE_CREATION_RATE_LIMITED" }
      });
      expect(ghRequest).toHaveBeenCalledTimes(3);
      expect(await listDevelopers(db)).toHaveLength(0);

      const otherAccount = await put(
        "/extensions/v2/developers/me",
        await authHeaders("independent-rate-limit-account"),
        { id: "other-attempt", type: "user", name: "Other attempt" }
      );
      expect(otherAccount.status).toBe(403);
      expect(ghRequest).toHaveBeenCalledTimes(4);
      expect(await listDevelopers(db)).toHaveLength(0);
    });

    it("does not charge profile updates against creation allowance", async () => {
      const headers = await authHeaders("update-rate-limit-account");
      const created = await put(
        "/extensions/v2/developers/me",
        headers,
        sampleDeveloper({ id: "update-limit-profile" })
      );
      expect(created.status).toBe(200);

      for (const name of ["First update", "Second update", "Third update"]) {
        const updated = await put(
          "/extensions/v2/developers/me",
          headers,
          sampleDeveloper({ id: "update-limit-profile", name })
        );
        expect(updated.status).toBe(200);
      }
      expect(ghRequest).toHaveBeenCalledTimes(1);

      const removed = await del("/extensions/v2/developers/me", headers);
      expect(removed.status).toBe(200);
      mockGithubEntity("Organization");

      for (const id of ["remaining-one", "remaining-two"]) {
        const allowed = await put("/extensions/v2/developers/me", headers, {
          id,
          type: "user",
          name: id
        });
        expect(allowed.status).toBe(403);
      }
      const denied = await put("/extensions/v2/developers/me", headers, {
        id: "no-allowance",
        type: "user",
        name: "No allowance"
      });
      expect(denied.status).toBe(429);
      expect(ghRequest).toHaveBeenCalledTimes(3);
      expect(await listDevelopers(db)).toHaveLength(0);
    });

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

    it("classifies a concurrent id collision as DEVELOPER_ID_TAKEN", async () => {
      const headers = await authHeaders("user-1");
      let raced = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!raced && sql.includes("INSERT INTO developers")) {
          raced = true;
          await insertDeveloper(db, {
            id: "raced-developer",
            type: "user",
            name: "Concurrent Creator",
            owner_user_id: "user-2"
          });
        }
      });

      const res = await put(
        "/extensions/v2/developers/me",
        headers,
        sampleDeveloper({ id: "raced-developer" })
      );
      env.DB_EXTENSIONS = db;

      expect(raced).toBe(true);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: "DEVELOPER_ID_TAKEN" }
      });
      expect((await getDeveloper(db, "raced-developer"))?.owner_user_id).toBe(
        "user-2"
      );
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

    it("keeps username verification independent of organization expiry", async () => {
      mockGithubEntity("User");
      await insertUser(db, {
        id: "user-1",
        github_login: "dev-developer",
        github_orgs: JSON.stringify(["former-org"]),
        github_orgs_expires_at: "2000-01-01T00:00:00.000Z"
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(body.result.github_org_verified).toBe(true);
    });

    it.each([
      ["expired", "2000-01-01T00:00:00.000Z"],
      ["missing", null],
      ["malformed", "2099"]
    ])(
      "falls back to manual review when %s GitHub membership evidence is unavailable",
      async (_state, github_orgs_expires_at) => {
        mockGithubEntity("Organization");
        await insertUser(db, {
          id: "user-1",
          github_login: "someone",
          github_orgs: JSON.stringify(["acme-org"]),
          github_orgs_expires_at
        });

        const res = await put(
          "/extensions/v2/developers/me",
          await authHeaders("user-1"),
          { id: "acme-org", type: "organization", name: "Acme Org" }
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          result: { github_org_verified?: boolean };
        };
        expect(body.result.github_org_verified).toBeUndefined();
      }
    );

    it("falls back to manual review when the linked GitHub login is whitespace-only", async () => {
      mockGithubEntity("Organization");
      await insertUser(db, {
        id: "user-1",
        github_login: "   ",
        github_orgs: JSON.stringify(["acme-org"]),
        github_orgs_expires_at: "2099-01-01T00:00:00.000Z"
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { id: "acme-org", type: "organization", name: "Acme Org" }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { github_org_verified?: boolean };
      };
      expect(body.result.github_org_verified).toBeUndefined();
    });

    it("does not verify an organization from a fresh confirmed empty list", async () => {
      mockGithubEntity("Organization");
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify([]),
        github_orgs_expires_at: "2099-01-01T00:00:00.000Z"
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { id: "acme-org", type: "organization", name: "Acme Org" }
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GITHUB_MISMATCH");
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
        result: {
          github_org_verified?: boolean;
          github_url_verified?: boolean;
        };
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

    it.each([
      ["401 authentication failure", 401, "Bad credentials", 503],
      ["rate-limit 403", 403, "API rate limit exceeded", 429],
      ["429 throttling", 429, "Too Many Requests", 429],
      ["GitHub 500", 500, "Internal Server Error", 503],
      ["GitHub 503", 503, "Service Unavailable", 503]
    ])(
      "does not create a developer when GitHub returns %s",
      async (_case, upstreamStatus, message, expectedStatus) => {
        (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
          async () => {
            throw Object.assign(new Error(message as string), {
              status: upstreamStatus
            });
          }
        );

        const res = await put(
          "/extensions/v2/developers/me",
          await authHeaders("user-1"),
          { id: "unavailable-dev", type: "user", name: "Unavailable" }
        );

        expect(res.status).toBe(expectedStatus);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe(
          expectedStatus === 429 ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE"
        );
        expect(await hasDeveloper(db, "unavailable-dev")).toBe(false);
      }
    );

    it.each(["request timed out", "network connection reset"])(
      "does not create a developer after a thrown %s error",
      async (message) => {
        (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
          async () => {
            throw new Error(message);
          }
        );

        const res = await put(
          "/extensions/v2/developers/me",
          await authHeaders("user-1"),
          { id: "unavailable-dev", type: "user", name: "Unavailable" }
        );

        expect(res.status).toBe(503);
        expect(await hasDeveloper(db, "unavailable-dev")).toBe(false);
      }
    );

    it.each([
      ["missing entity type", { blog: null }],
      ["non-string entity type", { type: 123, blog: null }],
      ["malformed website", { type: "User", blog: { url: "example.com" } }]
    ])(
      "does not create a developer for %s response data",
      async (_case, data) => {
        (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
          async () => ({ data })
        );

        const res = await put(
          "/extensions/v2/developers/me",
          await authHeaders("user-1"),
          { id: "invalid-response", type: "user", name: "Invalid" }
        );

        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
        expect(await hasDeveloper(db, "invalid-response")).toBe(false);
      }
    );

    it("returns a permanent error for an unsupported GitHub entity type", async () => {
      (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
        async () => ({ data: { type: "Bot", blog: null } })
      );

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        { id: "unsupported-entity", type: "user", name: "Unsupported" }
      );

      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("GITHUB_ENTITY_UNSUPPORTED");
      expect(await hasDeveloper(db, "unsupported-entity")).toBe(false);
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

    it.each(["claims", "me", "unapproved"])(
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
        result: {
          github_org_verified?: boolean;
          github_url_verified?: boolean;
        };
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
        result: {
          github_org_verified?: boolean;
          github_url_verified?: boolean;
        };
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

    it("reports an inactive account when deactivated during an existing profile update", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      let deactivated = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        const normalizedSql = sql.toLowerCase();
        if (
          !deactivated &&
          normalizedSql.includes('update "developers"') &&
          normalizedSql.includes("content_revision")
        ) {
          deactivated = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), "user-1")
            .run();
        }
      });

      const res = await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper({ name: "Inactive owner write" })
      );
      env.DB_EXTENSIONS = db;

      expect(deactivated).toBe(true);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "ACCOUNT_INACTIVE", message: "Active account required" }
      });
      expect((await getDeveloper(db, "dev-developer"))?.name).toBe(
        "Dev Developer"
      );
    });

    it("does not create a profile after the account is tombstoned mid-request", async () => {
      const headers = await authHeaders("deleted-during-write");
      let tombstoned = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!tombstoned && sql.includes("INSERT INTO developers")) {
          tombstoned = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), "deleted-during-write")
            .run();
        }
      });

      const res = await put(
        "/extensions/v2/developers/me",
        headers,
        sampleDeveloper({ id: "deleted-during-write-profile" })
      );
      env.DB_EXTENSIONS = db;

      expect(tombstoned).toBe(true);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "ACCOUNT_INACTIVE", message: "Active account required" }
      });
      expect(await hasDeveloper(db, "deleted-during-write-profile")).toBe(
        false
      );
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

    // The DELETE statements re-check ownership themselves rather than trusting
    // the SELECT that resolved the caller's profile, because an accepted
    // transfer or claim can move ownership in between. That guard is the only
    // authorization check on this path, so both its halves are pinned here:
    // that the profile survives, and that the batch is all-or-nothing.
    it("does not delete a profile whose ownership moved after it was resolved", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("owner-before"),
        sampleDeveloper({ id: "raced-delete" })
      );
      await insertUser(db, { id: "owner-after" });

      let raced = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        // Fires before the guarded DELETE batch is sent, which is the window
        // the guard exists to close.
        if (!raced && sql.includes("DELETE FROM developers")) {
          raced = true;
          await db
            .prepare("UPDATE developers SET owner_user_id = ? WHERE id = ?")
            .bind("owner-after", "raced-delete")
            .run();
        }
      });

      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("owner-before")
      );
      env.DB_EXTENSIONS = db;

      expect(raced).toBe(true);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: { code: "NOT_FOUND" }
      });

      // The row survives, still owned by whoever won the race.
      const developer = await getDeveloper(db, "raced-delete");
      expect(developer?.owner_user_id).toBe("owner-after");
    });

    it("leaves pending transfers intact when the profile delete is blocked", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("owner-before"),
        sampleDeveloper({ id: "raced-delete" })
      );
      await insertUser(db, { id: "owner-after" });
      await insertDeveloperTransfer(db, {
        id: "transfer-1",
        developer_id: "raced-delete",
        created_by: "owner-before",
        token_hash: "hash-1",
        expires_at: "2099-01-01T00:00:00.000Z"
      });

      let raced = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!raced && sql.includes("DELETE FROM developers")) {
          raced = true;
          await db
            .prepare("UPDATE developers SET owner_user_id = ? WHERE id = ?")
            .bind("owner-after", "raced-delete")
            .run();
        }
      });

      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("owner-before")
      );
      env.DB_EXTENSIONS = db;

      expect(res.status).toBe(404);
      // The transfer delete carries the same guard, so a blocked profile
      // delete must not strip the transfer out from under it.
      expect(await listDeveloperTransfers(db)).toHaveLength(1);
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

    it("reports an inactive owner when the account is deactivated during deletion", async () => {
      await put(
        "/extensions/v2/developers/me",
        await authHeaders("user-1"),
        sampleDeveloper()
      );

      let deactivated = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!deactivated && sql.includes("DELETE FROM developer_transfers")) {
          deactivated = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), "user-1")
            .run();
        }
      });

      const res = await del(
        "/extensions/v2/developers/me",
        await authHeaders("user-1")
      );
      env.DB_EXTENSIONS = db;

      expect(deactivated).toBe(true);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "ACCOUNT_INACTIVE", message: "Active account required" }
      });
      expect(await hasDeveloper(db, "dev-developer")).toBe(true);
    });
  });

  describe("POST /developers/me/reverify", () => {
    it("reports an inactive account when deactivated during a URL cooldown reservation", async () => {
      await insertUser(db, { id: "user-1" });
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: "https://acme.example",
        owner_user_id: "user-1"
      });

      let deactivated = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        const normalizedSql = sql.toLowerCase();
        if (
          !deactivated &&
          normalizedSql.includes('update "developers"') &&
          normalizedSql.includes("url_check_cooldown_until")
        ) {
          deactivated = true;
          await db
            .prepare("UPDATE users SET deleted_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), "user-1")
            .run();
        }
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify?check_url=true",
        await authHeaders("user-1")
      );
      env.DB_EXTENSIONS = db;

      expect(deactivated).toBe(true);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "ACCOUNT_INACTIVE", message: "Active account required" }
      });
    });

    it("re-verifies and refreshes the timestamp when the owner's GitHub org still matches", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: null,
        owner_user_id: "user-1",
        github_org_verified: 1,
        github_verification_note:
          "Verified: caller's linked GitHub identity matches.",
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
      expect(body.result.github_verified_at).not.toBe(
        "2020-01-01T00:00:00.000Z"
      );
    });

    it.each([
      [
        "expired",
        JSON.stringify(["dev-developer"]),
        "2000-01-01T00:00:00.000Z"
      ],
      ["malformed", "not-json", "2099-01-01T00:00:00.000Z"]
    ])(
      "preserves verification when the owner's organization evidence is %s",
      async (_state, github_orgs, github_orgs_expires_at) => {
        await insertDeveloper(db, {
          id: "dev-developer",
          type: "organization",
          name: "Dev",
          url: null,
          owner_user_id: "user-1",
          github_org_verified: 1,
          github_verification_note:
            "Verified: caller's linked GitHub identity matches.",
          github_verified_at: "2020-01-01T00:00:00.000Z"
        });
        await insertUser(db, {
          id: "user-1",
          github_login: "someone",
          github_orgs,
          github_orgs_expires_at
        });

        const res = await post(
          "/extensions/v2/developers/me/reverify",
          await authHeaders("user-1")
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          result: {
            github_org_verified?: boolean;
            github_verified_at?: string;
          };
        };
        expect(body.result.github_org_verified).toBe(true);
        expect(body.result.github_verified_at).toBe("2020-01-01T00:00:00.000Z");
      }
    );

    it("preserves verification when the owner's GitHub login is whitespace-only", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: null,
        owner_user_id: "user-1",
        github_org_verified: 1,
        github_verification_note:
          "Verified: caller's linked GitHub identity matches.",
        github_verified_at: "2020-01-01T00:00:00.000Z"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "   ",
        github_orgs: JSON.stringify(["dev-developer"]),
        github_orgs_expires_at: "2099-01-01T00:00:00.000Z"
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
      expect(body.result.github_verified_at).toBe("2020-01-01T00:00:00.000Z");
    });

    it("flips to unverified when the owner's GitHub org membership no longer matches", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: null,
        owner_user_id: "user-1",
        github_org_verified: 1,
        github_verification_note:
          "Verified: caller's linked GitHub identity matches.",
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
        result: {
          github_org_verified?: boolean;
          github_verification_note?: string;
        };
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

    it.each([
      [403, "API rate limit exceeded", 429, "RATE_LIMITED"],
      [503, "Service Unavailable", 503, "SERVICE_UNAVAILABLE"]
    ])(
      "returns an error and retains the cooldown when GitHub responds with %s",
      async (upstreamStatus, message, expectedStatus, expectedCode) => {
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
        (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
          async () => {
            throw Object.assign(new Error(message as string), {
              status: upstreamStatus
            });
          }
        );

        const failed = await post(
          "/extensions/v2/developers/me/reverify?check_url=true",
          await authHeaders("user-1")
        );
        expect(failed.status).toBe(expectedStatus);
        const body = (await failed.json()) as { error: { code: string } };
        expect(body.error.code).toBe(expectedCode);
        expect(
          (await getDeveloper(db, "dev-developer"))?.github_url_verified
        ).toBe(1);

        vi.clearAllMocks();
        const retry = await post(
          "/extensions/v2/developers/me/reverify?check_url=true",
          await authHeaders("user-1")
        );
        expect(retry.status).toBe(429);
        expect(ghRequest).not.toHaveBeenCalled();
      }
    );

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
      expect(
        (await getDeveloper(db, "dev-developer"))?.github_url_verified
      ).toBe(null);
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
        result: {
          github_org_verified?: boolean;
          github_url_verified?: boolean;
        };
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
        result: {
          github_org_verified?: boolean;
          github_url_verified?: boolean;
        };
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

    it("refuses to overwrite verification if the profile type changes during the check", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: null,
        owner_user_id: "user-1",
        github_org_verified: 1,
        github_verification_note:
          "Verified: caller's linked GitHub identity matches.",
        github_verified_at: "2020-01-01T00:00:00.000Z"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"])
      });

      let changed = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!changed && sql.includes("github_verified_at")) {
          changed = true;
          await db
            .prepare("UPDATE developers SET type = ? WHERE id = ?")
            .bind("user", "dev-developer")
            .run();
        }
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      env.DB_EXTENSIONS = db;

      expect(changed).toBe(true);
      expect(res.status).toBe(409);
      const developerRow = await getDeveloper(db, "dev-developer");
      expect(developerRow?.type).toBe("user");
      expect(developerRow?.github_org_verified).toBe(1);
      expect(developerRow?.github_verified_at).toBe("2020-01-01T00:00:00.000Z");
    });

    it("refuses to overwrite verification if GitHub identity sync wins the race", async () => {
      await insertDeveloper(db, {
        id: "dev-developer",
        type: "organization",
        name: "Dev",
        url: null,
        owner_user_id: "user-1",
        github_org_verified: 1,
        github_verification_note:
          "Verified: caller's linked GitHub identity matches.",
        github_verified_at: "2020-01-01T00:00:00.000Z"
      });
      await insertUser(db, {
        id: "user-1",
        github_login: "someone",
        github_orgs: JSON.stringify(["dev-developer"]),
        github_orgs_expires_at: "2099-01-01T00:00:00.000Z"
      });

      let synced = false;
      env.DB_EXTENSIONS = wrapD1WithHook(db, async (sql) => {
        if (!synced && sql.includes("github_verified_at")) {
          synced = true;
          await db
            .prepare(
              `UPDATE users
               SET github_login = ?, github_orgs = ?, github_orgs_expires_at = ?,
                   updated_at = ?
               WHERE id = ?`
            )
            .bind(
              "different-user",
              JSON.stringify(["different-org"]),
              "2099-01-01T00:00:00.000Z",
              new Date().toISOString(),
              "user-1"
            )
            .run();
        }
      });

      const res = await post(
        "/extensions/v2/developers/me/reverify",
        await authHeaders("user-1")
      );
      env.DB_EXTENSIONS = db;

      expect(synced).toBe(true);
      expect(res.status).toBe(409);
      const developerRow = await getDeveloper(db, "dev-developer");
      expect(developerRow?.github_org_verified).toBe(1);
      expect(developerRow?.github_verified_at).toBe("2020-01-01T00:00:00.000Z");
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
        approved: true,
        unclaimed: false
      });
      expect(body.result.contact_email).toBeUndefined();
    });

    it("404s for an unknown developer", async () => {
      const res = await get("/extensions/v2/developers/no-such-developer", {});
      expect(res.status).toBe(404);
    });

    it("marks an unowned developer as unclaimed", async () => {
      await seedUnownedDeveloper("legacy-public");

      const res = await get("/extensions/v2/developers/legacy-public", {});
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        result: { id: "legacy-public", unclaimed: true }
      });
    });
  });
});
