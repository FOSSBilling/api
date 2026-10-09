import { isolateEdgeCache } from "../../../utils/isolate-edge-cache";
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
import {
  MockGitHubGraphQL,
  MockGitHubRequest
} from "../../../utils/test-types";

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

vi.mock("@octokit/graphql", () => ({
  graphql: vi.fn()
}));

import { request as ghRequest } from "@octokit/request";
import { graphql } from "@octokit/graphql";
import { resetUpdateTokenCache } from "../../../../src/services/versions/v1/index";

// The stock Hono middleware (cors, trailing-slash, etag, bearer-auth,
// pretty-json) is not re-tested here; those behaviors are covered once at
// the integration layer. This suite keeps only the headers this service's
// own middleware decides.
const PUBLIC_HEADERS = { authorization: "test-bypass-cache" } as const;

let restoreConsole: (() => void) | null = null;

const resetEdgeCache = isolateEdgeCache();

describe("Versions API v1 - response headers", () => {
  beforeEach(async () => {
    restoreConsole = suppressConsole();
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

  afterEach(() => {
    if (restoreConsole) {
      restoreConsole();
      restoreConsole = null;
    }
  });

  // stampCacheHeaders must not let a transient failure inherit a cacheable
  // header: FOSSBilling's Update.php honors Cache-Control.
  it("does not set Vary when the GitHub API fails", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockRejectedValueOnce(
      new Error("GitHub API Error")
    );

    const ctx = createExecutionContext();
    const response = await app.request(
      "/versions/v1",
      { headers: PUBLIC_HEADERS },
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get("Vary")).toBeNull();
  });

  // The /update route sets no-store explicitly (awaited KV write; the
  // response must never be cached).
  it("does not cache update endpoint responses", async () => {
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
    expect(response.headers.get("Cache-Control")).toMatch(/no-store|no-cache/i);
  });
});
