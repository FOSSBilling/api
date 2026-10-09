import { isolateEdgeCache } from "../../utils/isolate-edge-cache";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../src/app";

const BYPASS_CACHE = { authorization: "test-bypass-cache" } as const;
import {
  mockGitHubReleases,
  mockComposerJson
} from "../../mocks/github-releases";
import { setupGitHubApiMock } from "../../utils/mock-helpers";
import {
  MockGitHubGraphQL,
  MockGitHubRequest,
  ApiResponse,
  VersionInfo
} from "../../utils/test-types";

vi.mock("@octokit/request", async () =>
  (await import("../../mocks/octokit")).octokitRequestMock()
);

vi.mock("@octokit/graphql", () => ({
  graphql: vi.fn()
}));

import { request as ghRequest } from "@octokit/request";
import { graphql } from "@octokit/graphql";
import { resetUpdateTokenCache } from "../../../src/services/versions/v1/index";

const resetEdgeCache = isolateEdgeCache();

// This suite keeps the cross-cutting scenarios the service-level suite
// cannot express: the /update endpoint actually rewriting the shared KV
// blob, endpoint consistency against one blob, the refresh path changing
// that blob, and cold-start concurrency. Everything else (warm-cache
// serving, auth failures, retry semantics) is covered in
// test/services/versions/v1/.
describe("Versions API v1 - Integration Tests", () => {
  beforeEach(async () => {
    await env.CACHE_KV.delete("gh-fossbilling-releases");
    resetUpdateTokenCache();
    await env.AUTH_KV.put("UPDATE_TOKEN", "test-update-token-12345");

    vi.resetAllMocks();
    resetEdgeCache();
    setupGitHubApiMock(
      vi.mocked(ghRequest) as MockGitHubRequest,
      vi.mocked(graphql) as unknown as MockGitHubGraphQL,
      mockGitHubReleases,
      mockComposerJson
    );
  });

  it("rewrites the shared KV blob via the authenticated update endpoint", async () => {
    let cached = await env.CACHE_KV.get("gh-fossbilling-releases");
    expect(cached).toBeFalsy();

    const ctx1 = createExecutionContext();
    const response1 = await app.request(
      "/versions/v1/update",
      {
        headers: {
          Authorization: "Bearer test-update-token-12345"
        }
      },
      env,
      ctx1
    );
    await waitOnExecutionContext(ctx1);

    expect(response1.status).toBe(200);
    const data1 = (await response1.json()) as ApiResponse<string>;
    expect(data1.result).toContain("updated successfully");

    cached = await env.CACHE_KV.get("gh-fossbilling-releases");
    expect(cached).toBeTruthy();

    const ctx2 = createExecutionContext();
    const response2 = await app.request(
      "/versions/v1",
      { headers: BYPASS_CACHE },
      env,
      ctx2
    );
    await waitOnExecutionContext(ctx2);

    expect(response2.status).toBe(200);
  });

  it("returns consistent data across all endpoints", async () => {
    const ctx1 = createExecutionContext();
    const response1 = await app.request(
      "/versions/v1",
      { headers: BYPASS_CACHE },
      env,
      ctx1
    );
    await waitOnExecutionContext(ctx1);
    const allVersions: ApiResponse<Record<string, VersionInfo>> =
      await response1.json();

    const ctx2 = createExecutionContext();
    const response2 = await app.request(
      "/versions/v1/latest",
      { headers: BYPASS_CACHE },
      env,
      ctx2
    );
    await waitOnExecutionContext(ctx2);
    const latest = (await response2.json()) as ApiResponse<VersionInfo | null>;

    const ctx3 = createExecutionContext();
    const response3 = await app.request(
      "/versions/v1/0.6.0",
      { headers: BYPASS_CACHE },
      env,
      ctx3
    );
    await waitOnExecutionContext(ctx3);
    const specific =
      (await response3.json()) as ApiResponse<VersionInfo | null>;

    expect(latest.result).toEqual(allVersions.result["0.6.0"]);
    expect(specific.result).toEqual(allVersions.result["0.6.0"]);
  });

  it("refreshes the cached blob with new upstream content on update", async () => {
    const ctx1 = createExecutionContext();
    await app.request("/versions/v1", { headers: BYPASS_CACHE }, env, ctx1);
    await waitOnExecutionContext(ctx1);

    const cachedBefore = await env.CACHE_KV.get("gh-fossbilling-releases");

    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/releases") {
          return {
            data: [
              {
                id: 9999,
                tag_name: "9.9.9",
                name: "9.9.9",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                body: "New release",
                assets: [
                  {
                    name: "FOSSBilling.zip",
                    browser_download_url: "https://example.com/new.zip",
                    size: 2000000
                  }
                ]
              }
            ]
          };
        }
        if (route === "GET /repos/{owner}/{repo}/contents/{path}{?ref}") {
          const content = btoa(JSON.stringify(mockComposerJson));
          return { data: { content } };
        }
        throw new Error("Unexpected route");
      }
    );

    const ctx2 = createExecutionContext();
    await app.request(
      "/versions/v1/update",
      {
        headers: {
          Authorization: "Bearer test-update-token-12345"
        }
      },
      env,
      ctx2
    );
    await waitOnExecutionContext(ctx2);

    const cachedAfter = await env.CACHE_KV.get("gh-fossbilling-releases");

    expect(cachedAfter).not.toBe(cachedBefore);
    expect(cachedAfter).toContain("9.9.9");
  });

  it("handles concurrent cold-start requests gracefully", async () => {
    await env.CACHE_KV.delete("gh-fossbilling-releases");

    const promises = [];
    for (let i = 0; i < 10; i++) {
      const ctx = createExecutionContext();
      const promise = (async () => {
        const response = await app.request(
          "/versions/v1",
          { headers: BYPASS_CACHE },
          env,
          ctx
        );
        await waitOnExecutionContext(ctx);
        return response.json();
      })();
      promises.push(promise);
    }

    const results = await Promise.all(promises);

    results.forEach((result) => {
      const r = result as ApiResponse;
      expect(r.error_code).toBe(0);
      expect(
        Object.keys(r.result as Record<string, unknown>).length
      ).toBeGreaterThan(0);
    });
  });
});
