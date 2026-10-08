import { isolateEdgeCache } from "../utils/isolate-edge-cache";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../src/app/index";

// Arbitrary credentials use the public cache; isolate entries between tests.
const BYPASS_CACHE = { authorization: "test-bypass-cache" } as const;
import { mockGitHubReleases, mockComposerJson } from "../mocks/github-releases";
import { setupGitHubApiMock } from "../utils/mock-helpers";
import { applyTestMigrations } from "../utils/apply-migrations";
import {
  ApiResponse,
  CentralAlertsResponse,
  MockGitHubGraphQL,
  MockGitHubRequest,
  VersionInfo
} from "../utils/test-types";

vi.mock("@octokit/request", async () =>
  (await import("../mocks/octokit")).octokitRequestMock()
);

vi.mock("@octokit/graphql", () => ({
  graphql: vi.fn()
}));

import { request as ghRequest } from "@octokit/request";
import { graphql } from "@octokit/graphql";
import { resetUpdateTokenCache } from "../../src/services/versions/v1/index";

const resetEdgeCache = isolateEdgeCache();

describe("FOSSBilling API Worker - Full App Integration", () => {
  beforeAll(applyTestMigrations);

  beforeEach(async () => {
    await env.CACHE_KV.delete("gh-fossbilling-releases");
    resetUpdateTokenCache();
    await env.AUTH_KV.put("UPDATE_TOKEN", "test-update-token-12345");

    vi.clearAllMocks();
    resetEdgeCache();
    setupGitHubApiMock(
      vi.mocked(ghRequest) as MockGitHubRequest,
      vi.mocked(graphql) as unknown as MockGitHubGraphQL,
      mockGitHubReleases,
      mockComposerJson
    );
  });

  describe("Service Discovery and Routing", () => {
    it("should route to all services correctly", async () => {
      const ctx1 = createExecutionContext();
      const versionsResponse = await app.request(
        "/versions/v1",
        { headers: BYPASS_CACHE },
        env,
        ctx1
      );
      await waitOnExecutionContext(ctx1);

      const ctx2 = createExecutionContext();
      const alertsResponse = await app.request(
        "/central-alerts/v1/list",
        { headers: BYPASS_CACHE },
        env,
        ctx2
      );
      await waitOnExecutionContext(ctx2);

      const ctx3 = createExecutionContext();
      const statsResponse = await app.request(
        "/stats/v1/data",
        { headers: BYPASS_CACHE },
        env,
        ctx3
      );
      await waitOnExecutionContext(ctx3);

      expect(versionsResponse.status).toBe(200);
      expect(alertsResponse.status).toBe(200);
      expect(statsResponse.status).toBe(200);

      const versionsData = (await versionsResponse.json()) as ApiResponse<
        Record<string, VersionInfo>
      >;
      const alertsData = (await alertsResponse.json()) as CentralAlertsResponse;

      expect(versionsData).toHaveProperty("result");
      expect(versionsData).toHaveProperty("error_code", 0);
      expect(alertsData).toHaveProperty("result");
      expect(alertsData.result.alerts.length).toBeGreaterThan(0);
    });

    it("resolves the latest release through the full middleware stack", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/latest",
        { headers: BYPASS_CACHE },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as ApiResponse<VersionInfo | null>;
      expect(data.result?.version).toBe("0.6.0");
    });

    it("should return 404 for unknown routes", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/unknown/path",
        { headers: BYPASS_CACHE },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
    });

    it("should return service information at root path", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/",
        { headers: BYPASS_CACHE },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as ApiResponse<null>;
      expect(data.result).toBe(null);
      expect(data.error_code).toBe(0);
      expect(data.message).toContain("FOSSBilling API");
    });
  });

  // The versions KV write is asserted once here for the whole app; the
  // /update auth matrix lives in test/services/versions/v1 and the KV-rewrite
  // flow in integration/versions.
  describe("Cross-Service Communication", () => {
    it("exposes environment bindings and the shared cache to all services", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1",
        { headers: BYPASS_CACHE },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const cached = await env.CACHE_KV.get("gh-fossbilling-releases");
      expect(cached).toBeTruthy();
    });

    it("should provide KV namespace for central alerts", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        { headers: BYPASS_CACHE },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as CentralAlertsResponse;
      expect(data.result.alerts).toBeInstanceOf(Array);
    });

    it("rejects unauthenticated update requests", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/update", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
    });

    it("returns 404 for invalid service routes", async () => {
      const endpoints = [
        "/versions/v1/invalid-endpoint",
        "/central-alerts/v1/invalid"
      ];

      for (const endpoint of endpoints) {
        const ctx = createExecutionContext();
        const response = await app.request(endpoint, {}, env, ctx);
        await waitOnExecutionContext(ctx);

        expect(response.status).toBe(404);
      }
    });
  });

  // Method-level behavior is Hono routing, already exercised by every
  // request in this suite; the surviving assertions are the cross-service
  // headers the wiring owns.
  describe("Headers and Middleware", () => {
    it("should include CORS headers on all responses", async () => {
      const endpoints = [
        "/versions/v1",
        "/central-alerts/v1/list",
        "/stats/v1/data",
        "/stats/v1"
      ];

      for (const endpoint of endpoints) {
        const ctx = createExecutionContext();
        const response = await app.request(endpoint, {}, env, ctx);
        await waitOnExecutionContext(ctx);

        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      }
    });

    it("should include ETag headers on cacheable responses", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1",
        { headers: BYPASS_CACHE },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      const etag = response.headers.get("ETag");
      expect(etag).toBeTruthy();
    });
  });
});
