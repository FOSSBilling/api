/**
 * Tests for FOSSBilling API Worker - Main Application
 *
 * @license AGPL-3.0
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import app from "../../src/app/index";
import { mockD1Database } from "../utils/d1-mock";
import {
  ApiResponse,
  CentralAlertsResponse,
  GitHubContentResponse,
  MockGitHubRequest,
  VersionInfo,
  VersionsResponse
} from "../utils/test-types";

vi.mock("@octokit/request", () => {
  const endpoint = { DEFAULTS: {} };
  const derivedFn = Object.assign(vi.fn(), { defaults: vi.fn(), endpoint });
  const request = Object.assign(vi.fn(), {
    defaults: vi.fn().mockReturnValue(derivedFn),
    endpoint
  });
  return { request };
});

vi.mock("@octokit/graphql", () => ({
  graphql: vi.fn()
}));

import { request as ghRequest } from "@octokit/request";
import { graphql } from "@octokit/graphql";
import { resetUpdateTokenCache } from "../../src/services/versions/v1/index";
import { createGraphQLImplementation } from "../utils/mock-helpers";
import { MockGitHubGraphQL } from "../utils/test-types";

const mockGitHubReleases = [
  {
    id: 1001,
    tag_name: "0.6.0",
    name: "0.6.0",
    published_at: "2023-04-01T00:00:00Z",
    prerelease: false,
    body: "## 0.6.0\n- New features",
    assets: [
      {
        name: "FOSSBilling.zip",
        browser_download_url:
          "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.6.0/FOSSBilling.zip",
        size: 1030000
      }
    ]
  }
];

const mockComposerJson = {
  require: {
    php: "^8.1"
  }
};

describe("FOSSBilling API Worker - Main App", () => {
  beforeEach(async () => {
    // Clear KV cache before each test
    await env.CACHE_KV.delete("gh-fossbilling-releases");
    resetUpdateTokenCache();

    // Set up UPDATE_TOKEN in AUTH_KV storage for tests
    const testUpdateToken = "test-update-token-12345";
    await env.AUTH_KV.put("UPDATE_TOKEN", testUpdateToken);

    // Mock D1 database binding for central alerts
    env.DB_CENTRAL_ALERTS = mockD1Database;

    // Reset all mocks
    vi.clearAllMocks();

    // Setup default GitHub API mock responses
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/releases") {
          return { data: mockGitHubReleases };
        }
        if (route === "GET /repos/{owner}/{repo}/contents/{path}{?ref}") {
          const content = btoa(JSON.stringify(mockComposerJson));
          return {
            data: {
              content: content
            }
          } as GitHubContentResponse;
        }
        throw new Error("Unexpected route");
      }
    );

    (vi.mocked(graphql) as unknown as MockGitHubGraphQL).mockImplementation(
      createGraphQLImplementation(mockComposerJson)
    );
  });

  describe("Route Delegation", () => {
    it("should route /versions/v1 to versions service", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: VersionsResponse = await response.json();

      // Should return versions API response format
      expect(data).toHaveProperty("result");
      expect(data).toHaveProperty("error_code");
      expect(data).toHaveProperty("message");
    });

    it("should route /central-alerts/v1/list to central alerts service", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: CentralAlertsResponse = await response.json();

      // Should return central alerts response format
      expect(data).toHaveProperty("result");
      expect(data.result).toHaveProperty("alerts");
      expect(Array.isArray(data.result.alerts)).toBe(true);
    });

    it("should return 404 for unknown routes", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/unknown/path", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
    });

    it("should return 200 with notice for root path", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: ApiResponse<null> = await response.json();
      expect(data.result).toBe(null);
      expect(data.error_code).toBe(0);
      expect(data.message).toContain("FOSSBilling API");
    });
  });

  describe("Context Storage Middleware", () => {
    it("should make context available to nested routes", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      // If context storage works, the versions endpoint should be able to access env bindings
      expect(response.status).toBe(200);
      const data: VersionsResponse = await response.json();

      // Should successfully fetch from GitHub (via context storage)
      expect(data.result).toBeTruthy();
    });

    it("should provide access to KV namespace through context", async () => {
      const ctx = createExecutionContext();
      await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      // Verify that KV was accessed (data should be cached)
      const cached = await env.CACHE_KV.get("gh-fossbilling-releases");
      expect(cached).toBeTruthy();
    });

    it("should provide access to environment variables through context", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/update",
        {
          headers: {
            Authorization: "Bearer test-update-token-12345"
          }
        },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      // Should be able to access UPDATE_TOKEN from KV storage
      expect(response.status).toBe(200);
    });
  });

  describe("Service Integration", () => {
    it("should allow versions service to function correctly", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/latest", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: ApiResponse<VersionInfo | null> = await response.json();

      expect(data.result).toBeTruthy();
      if (!data.result) {
        throw new Error("Expected version info in response");
      }
      expect(data.result.version).toBe("0.6.0");
    });

    it("should allow central alerts service to return static data", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: CentralAlertsResponse = await response.json();

      expect(data.result.alerts.length).toBeGreaterThan(0);
    });
  });

  describe("HTTP Methods", () => {
    it("should handle GET requests", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1",
        {
          method: "GET"
        },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
    });

    it("should return 404 for unsupported methods on unknown routes", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1",
        {
          method: "POST"
        },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      // Hono returns 404 for unsupported methods
      expect(response.status).toBe(404);
    });
  });
});
