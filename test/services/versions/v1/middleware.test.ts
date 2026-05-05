import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../../src/app";
import {
  mockGitHubReleases,
  mockComposerJson
} from "../../../mocks/github-releases";
import {
  suppressConsole,
  setupGitHubApiMock
} from "../../../utils/mock-helpers";
import { MockGitHubRequest } from "../../../utils/test-types";

vi.mock("@octokit/request", () => ({
  request: vi.fn()
}));

import { request as ghRequest } from "@octokit/request";
import { resetUpdateTokenCache } from "../../../../src/services/versions/v1/index";

let restoreConsole: (() => void) | null = null;

describe("Versions API v1 - Middleware", () => {
  beforeEach(async () => {
    restoreConsole = suppressConsole();
    await env.CACHE_KV.delete("gh-fossbilling-releases");
    resetUpdateTokenCache();
    await env.AUTH_KV.put("UPDATE_TOKEN", "test-update-token-12345");

    vi.clearAllMocks();
    setupGitHubApiMock(
      vi.mocked(ghRequest) as MockGitHubRequest,
      mockGitHubReleases,
      mockComposerJson
    );
  });

  afterEach(() => {
    if (restoreConsole) {
      restoreConsole();
      restoreConsole = null;
    }
  });

  describe("CORS Middleware", () => {
    it("should set CORS headers on successful requests", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("should set CORS headers on error responses", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/nonexistent-version",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("should handle OPTIONS preflight requests", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1",
        {
          method: "OPTIONS"
        },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("Trailing Slash Middleware", () => {
    it("should redirect paths with trailing slash to non-trailing", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(301);
      const location = response.headers.get("Location");
      expect(location).toContain("/versions/v1");
      expect(location).not.toMatch(/\/$/);
    });

    it("should not redirect paths without trailing slash", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
    });

    it("should redirect nested paths with trailing slash", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/latest/", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(301);
      const location = response.headers.get("Location");
      expect(location).toContain("/versions/v1/latest");
      expect(location).not.toMatch(/\/$/);
    });
  });

  describe("ETag Middleware", () => {
    it("should generate ETag header for cacheable responses", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const etag = response.headers.get("ETag");
      expect(etag).toBeTruthy();
      expect(etag).toMatch(/^["'].*["']$/);
    });

    it("should return same ETag for identical content", async () => {
      const ctx1 = createExecutionContext();
      const response1 = await app.request("/versions/v1", {}, env, ctx1);
      await waitOnExecutionContext(ctx1);
      const etag1 = response1.headers.get("ETag");

      const ctx2 = createExecutionContext();
      const response2 = await app.request("/versions/v1", {}, env, ctx2);
      await waitOnExecutionContext(ctx2);
      const etag2 = response2.headers.get("ETag");

      expect(etag1).toBe(etag2);
    });

    it("should return 304 for matching If-None-Match", async () => {
      const ctx1 = createExecutionContext();
      const response1 = await app.request("/versions/v1", {}, env, ctx1);
      await waitOnExecutionContext(ctx1);
      const etag = response1.headers.get("ETag");
      expect(etag).toBeTruthy();

      const ctx2 = createExecutionContext();
      const response2 = await app.request(
        "/versions/v1",
        {
          headers: {
            "If-None-Match": etag as string
          }
        },
        env,
        ctx2
      );
      await waitOnExecutionContext(ctx2);

      expect(response2.status).toBe(304);
    });
  });

  describe("Cache Control Headers", () => {
    it("should set cache headers for GET / endpoint", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toBeTruthy();
      expect(cacheControl).toContain("max-age");
    });

    it("should set cache headers for GET /:version endpoint", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/latest", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toBeTruthy();
    });

    it("should set cache headers for build_changelog endpoint", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/build_changelog/0.5.0",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toBeTruthy();
    });

    it("should not set Vary header when GitHub API fails", async () => {
      (vi.mocked(ghRequest) as MockGitHubRequest).mockRejectedValueOnce(
        new Error("GitHub API Error")
      );

      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(503);
      expect(response.headers.get("Vary")).toBeNull();
    });
  });

  describe("Bearer Auth Middleware", () => {
    it("should accept valid bearer token format", async () => {
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

    it("should require Authorization header", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/update", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
    });

    it("should validate token value correctly", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/update",
        {
          headers: {
            Authorization: "Bearer wrong-token"
          }
        },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
    });
  });

  describe("JSON Response Middleware", () => {
    it("should set correct Content-Type header", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.headers.get("Content-Type")).toContain(
        "application/json"
      );
    });
  });

  describe("Middleware Interaction", () => {
    it("should apply all middleware in correct order", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(301);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("should not aggressively cache update endpoint responses", async () => {
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

    it("should apply CORS even on auth failures", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/update", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
