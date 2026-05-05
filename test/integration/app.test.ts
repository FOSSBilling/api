import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../src/app/index";
import { mockGitHubReleases, mockComposerJson } from "../mocks/github-releases";
import { setupGitHubApiMock } from "../utils/mock-helpers";
import { mockD1Database } from "../utils/d1-mock";
import {
  ApiResponse,
  CentralAlertsResponse,
  MockGitHubRequest,
  VersionsResponse
} from "../utils/test-types";

vi.mock("@octokit/request", () => ({
  request: vi.fn()
}));

import { request as ghRequest } from "@octokit/request";
import { resetUpdateTokenCache } from "../../src/services/versions/v1/index";

describe("FOSSBilling API Worker - Full App Integration", () => {
  beforeEach(async () => {
    await env.CACHE_KV.delete("gh-fossbilling-releases");
    resetUpdateTokenCache();
    await env.AUTH_KV.put("UPDATE_TOKEN", "test-update-token-12345");

    env.DB_CENTRAL_ALERTS = mockD1Database;

    vi.clearAllMocks();
    setupGitHubApiMock(
      vi.mocked(ghRequest) as MockGitHubRequest,
      mockGitHubReleases,
      mockComposerJson
    );
  });

  describe("Service Discovery and Routing", () => {
    it("should route to all services correctly", async () => {
      const ctx1 = createExecutionContext();
      const versionsResponse = await app.request("/versions/v1", {}, env, ctx1);
      await waitOnExecutionContext(ctx1);

      const ctx2 = createExecutionContext();
      const alertsResponse = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx2
      );
      await waitOnExecutionContext(ctx2);

      const ctx3 = createExecutionContext();
      const statsResponse = await app.request("/stats/v1/data", {}, env, ctx3);
      await waitOnExecutionContext(ctx3);

      expect(versionsResponse.status).toBe(200);
      expect(alertsResponse.status).toBe(200);
      expect(statsResponse.status).toBe(200);

      const versionsData = (await versionsResponse.json()) as VersionsResponse;
      const alertsData = (await alertsResponse.json()) as CentralAlertsResponse;

      expect(versionsData).toHaveProperty("result");
      expect(versionsData).toHaveProperty("error_code", 0);
      expect(alertsData).toHaveProperty("result");
    });

    it("should return 404 for unknown routes", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/unknown/path", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
    });

    it("should return service information at root path", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as ApiResponse<null>;
      expect(data.result).toBe(null);
      expect(data.error_code).toBe(0);
      expect(data.message).toContain("FOSSBilling API");
    });
  });

  describe("Cross-Service Communication", () => {
    it("should allow services to share cached data", async () => {
      const ctx = createExecutionContext();
      await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const cached = await env.CACHE_KV.get("gh-fossbilling-releases");
      expect(cached).toBeTruthy();
    });
  });

  describe("Context Storage Middleware", () => {
    it("should make environment bindings available to all services", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const cached = await env.CACHE_KV.get("gh-fossbilling-releases");
      expect(cached).toBeTruthy();
    });

    it("should provide KV namespace for central alerts", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/central-alerts/v1/list",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as CentralAlertsResponse;
      expect(data.result.alerts).toBeInstanceOf(Array);
    });

    it("should handle UPDATE_TOKEN from KV storage", async () => {
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

      expect(response.status).toBe(200);
    });
  });

  describe("Error Handling Across Services", () => {
    it("should handle 404 for invalid service routes", async () => {
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

    it("should handle unauthorized update requests", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/update", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
    });
  });

  describe("Consistent API Response Format", () => {
    it("should maintain consistent response format across all services", async () => {
      const endpoints = [
        { path: "/versions/v1", fields: ["result", "error_code", "message"] },
        { path: "/central-alerts/v1/list", fields: ["result"] }
      ];

      for (const { path, fields } of endpoints) {
        const ctx = createExecutionContext();
        const response = await app.request(path, {}, env, ctx);
        await waitOnExecutionContext(ctx);

        const data = await response.json();
        for (const field of fields) {
          expect(data).toHaveProperty(field);
        }
      }
    });
  });

  describe("HTTP Method Handling", () => {
    it("should handle GET requests across all services", async () => {
      const endpoints = [
        "/versions/v1",
        "/versions/v1/latest",
        "/central-alerts/v1/list",
        "/stats/v1/data",
        "/stats/v1"
      ];

      for (const endpoint of endpoints) {
        const ctx = createExecutionContext();
        const response = await app.request(
          endpoint,
          { method: "GET" },
          env,
          ctx
        );
        await waitOnExecutionContext(ctx);

        expect([200, 301]).toContain(response.status);
      }
    });

    it("should return 404 for unsupported methods", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1",
        { method: "POST" },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
    });

    it("should handle OPTIONS preflight requests", async () => {
      const endpoints = ["/versions/v1"];

      for (const endpoint of endpoints) {
        const ctx = createExecutionContext();
        const response = await app.request(
          endpoint,
          { method: "OPTIONS" },
          env,
          ctx
        );
        await waitOnExecutionContext(ctx);

        expect([204, 405]).toContain(response.status);
        if (response.status === 204) {
          expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
        }
      }
    });
  });

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
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const etag = response.headers.get("ETag");
      expect(etag).toBeTruthy();
    });
  });
});
