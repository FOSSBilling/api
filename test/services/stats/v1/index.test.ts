import { isolateEdgeCache } from "../../../utils/isolate-edge-cache";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import app from "../../../../src/app";
import {
  mockGitHubReleases,
  mockComposerJson,
  mockMirroredRelease
} from "../../../mocks/github-releases";
import {
  suppressConsole,
  setupGitHubApiMock
} from "../../../utils/mock-helpers";
import {
  MockGitHubGraphQL,
  MockGitHubRequest
} from "../../../utils/test-types";
import type { StatsData } from "../../../../src/services/stats/v1/interfaces";

import { request as ghRequest } from "@octokit/request";
import { graphql } from "@octokit/graphql";
import { ApiResponse } from "../../../utils/test-types";

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

vi.mock("@octokit/graphql", () => ({
  graphql: vi.fn()
}));

let restoreConsole: (() => void) | null = null;

// Arbitrary credentials must behave like anonymous public requests.
// Edge entries are cleared between tests to exercise live handlers.
const PUBLIC_HEADERS = { authorization: "test-bypass-cache" } as const;

const resetEdgeCache = isolateEdgeCache();

describe("Stats API v1", () => {
  beforeEach(async () => {
    restoreConsole = suppressConsole();
    await env.CACHE_KV.delete("gh-fossbilling-releases");
    await env.CACHE_KV.delete("fossbilling-stats-data");
    await env.DOWNLOAD_BUCKET.delete("releases/0.8.0/FOSSBilling-0.8.0.zip");

    const testUpdateToken = "test-update-token-12345";
    await env.AUTH_KV.put("UPDATE_TOKEN", testUpdateToken);

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
    if (restoreConsole) restoreConsole();
  });

  // Both stats registrations share the public edge entry: credentials must
  // not fragment it, and a credentials-driven request must be served from
  // the edge without waking the backend (spied KV get must stay cold). This
  // is the stats-specific wiring; the mechanism itself is covered in
  // test/lib/cache.test.ts.
  it("serves both stats routes across credentials from the public edge entry", async () => {
    for (const path of ["/stats/v1", "/stats/v1/data"]) {
      const requestAs = async (authorization?: string) => {
        const ctx = createExecutionContext();
        const response = await app.request(
          path,
          {
            headers: authorization === undefined ? {} : { authorization }
          },
          env,
          ctx
        );
        await waitOnExecutionContext(ctx);
        return response;
      };
      const first = await requestAs("Bearer arbitrary-cold");
      expect(first.status).toBe(200);
      const body = await first.text();
      const get = vi
        .spyOn(env.CACHE_KV, "get")
        .mockRejectedValue(new Error("backend must not be read"));
      try {
        for (const authorization of [undefined, "x", "Bearer other", ""]) {
          const response = await requestAs(authorization);
          expect(response.status).toBe(200);
          await expect(response.text()).resolves.toBe(body);
        }
        expect(get).not.toHaveBeenCalled();
      } finally {
        get.mockRestore();
      }
    }
  });

  // A cached stats value must be served even when the shared releases read
  // rejects - getReleases' KV failure must not turn a warm /data request
  // into a 500.
  it("serves cached statistics when the shared releases read fails", async () => {
    const ctx1 = createExecutionContext();
    await app.request("/stats/v1/data", { headers: PUBLIC_HEADERS }, env, ctx1);
    await waitOnExecutionContext(ctx1);
    const cached = await env.CACHE_KV.get("fossbilling-stats-data");
    expect(cached).toBeTruthy();

    const realGet = env.CACHE_KV.get.bind(env.CACHE_KV) as (
      key: string
    ) => Promise<string | null>;
    const getSpy = vi.spyOn(env.CACHE_KV, "get");
    getSpy.mockImplementation(((key: string | string[]) => {
      const first = Array.isArray(key) ? key[0] : key;
      if (first === "gh-fossbilling-releases") {
        return Promise.reject(new Error("releases read failed"));
      }
      return realGet(key as string);
    }) as unknown as typeof env.CACHE_KV.get);
    try {
      const ctx2 = createExecutionContext();
      const response = await app.request(
        "/stats/v1/data",
        { headers: PUBLIC_HEADERS },
        env,
        ctx2
      );
      await waitOnExecutionContext(ctx2);

      expect(response.status).toBe(200);
      const data = (await response.json()) as ApiResponse<StatsData>;
      expect(data.error_code).toBe(0);
      expect(data.stale).toBe(false);
      expect(data.result.releaseSizes.length).toBeGreaterThan(0);
    } finally {
      getSpy.mockRestore();
    }
  });

  describe("GET /stats/v1/data", () => {
    it("should return aggregated statistics", async () => {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request("http://localhost/stats/v1/data", {
          headers: PUBLIC_HEADERS
        }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as ApiResponse<StatsData | null>;

      expect(data).toHaveProperty("result");
      expect(data).toHaveProperty("error_code", 0);

      expect(data.result).not.toBeNull();

      const result = data.result!;

      expect(result).toHaveProperty("releaseSizes");
      expect(result).toHaveProperty("phpVersions");
      expect(result).toHaveProperty("patchesPerRelease");
      expect(result).toHaveProperty("releasesPerYear");

      expect(Array.isArray(result.releaseSizes)).toBe(true);
      expect(Array.isArray(result.phpVersions)).toBe(true);
      expect(Array.isArray(result.patchesPerRelease)).toBe(true);
      expect(Array.isArray(result.releasesPerYear)).toBe(true);

      if (result.releaseSizes.length > 0) {
        expect(result.releaseSizes[0]).toHaveProperty("version");
        expect(result.releaseSizes[0]).toHaveProperty("size_mb");
        expect(result.releaseSizes[0]).toHaveProperty("released_on");
        expect(typeof result.releaseSizes[0].size_mb).toBe("number");
      }

      if (result.phpVersions.length > 0) {
        expect(result.phpVersions[0]).toHaveProperty("version");
        expect(result.phpVersions[0]).toHaveProperty("php_version");
        expect(result.phpVersions[0]).toHaveProperty("released_on");
      }

      if (result.patchesPerRelease.length > 0) {
        expect(result.patchesPerRelease[0]).toHaveProperty("version_line");
        expect(result.patchesPerRelease[0]).toHaveProperty("patch_count");
        expect(typeof result.patchesPerRelease[0].patch_count).toBe("number");
      }

      if (result.releasesPerYear.length > 0) {
        expect(result.releasesPerYear[0]).toHaveProperty("year");
        expect(result.releasesPerYear[0]).toHaveProperty("release_count");
        expect(typeof result.releasesPerYear[0].release_count).toBe("number");
      }
    });

    it("should cache statistics data", async () => {
      const ctx1 = createExecutionContext();
      const response1 = await app.fetch(
        new Request("http://localhost/stats/v1/data"),
        env,
        ctx1
      );
      await waitOnExecutionContext(ctx1);

      expect(response1.status).toBe(200);
      const data1 = (await response1.json()) as ApiResponse<StatsData | null>;

      const ctx2 = createExecutionContext();
      const response2 = await app.fetch(
        new Request("http://localhost/stats/v1/data"),
        env,
        ctx2
      );
      await waitOnExecutionContext(ctx2);

      expect(response2.status).toBe(200);
      const data2 = (await response2.json()) as ApiResponse<StatsData | null>;

      expect(data1.result).toEqual(data2.result);
      expect(data2.stale).toBe(false);
    });

    it("should handle empty releases data gracefully", async () => {
      vi.mocked(ghRequest).mockResolvedValue({
        data: [],
        headers: {},
        status: 200,
        url: "https://api.github.com/repos/FOSSBilling/FOSSBilling/releases"
      });

      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request("http://localhost/stats/v1/data", {
          headers: PUBLIC_HEADERS
        }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as ApiResponse<StatsData | null>;

      expect(data.result).not.toBeNull();
      expect(data.result).toEqual(
        expect.objectContaining({
          releaseSizes: [],
          phpVersions: [],
          patchesPerRelease: [],
          releasesPerYear: []
        })
      );
    });

    it("should sort version lines using semver comparison", async () => {
      const mockReleasesWithHighVersions = [
        ...mockGitHubReleases,
        {
          id: 1005,
          tag_name: "0.9.0",
          name: "0.9.0",
          published_at: "2023-09-01T00:00:00Z",
          prerelease: false,
          body: "## 0.9.0\n- Major update",
          assets: [
            {
              name: "FOSSBilling.zip",
              browser_download_url:
                "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.9.0/FOSSBilling.zip",
              size: 1040000
            }
          ]
        },
        {
          id: 1006,
          tag_name: "0.10.0",
          name: "0.10.0",
          published_at: "2023-10-01T00:00:00Z",
          prerelease: false,
          body: "## 0.10.0\n- Double digit release",
          assets: [
            {
              name: "FOSSBilling.zip",
              browser_download_url:
                "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.10.0/FOSSBilling.zip",
              size: 1050000
            }
          ]
        }
      ];

      vi.mocked(ghRequest).mockResolvedValue({
        data: mockReleasesWithHighVersions,
        headers: {},
        status: 200,
        url: "https://api.github.com/repos/FOSSBilling/FOSSBilling/releases"
      });

      await env.CACHE_KV.delete("gh-fossbilling-releases");
      await env.CACHE_KV.delete("fossbilling-stats-data");

      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request("http://localhost/stats/v1/data", {
          headers: PUBLIC_HEADERS
        }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as ApiResponse<StatsData | null>;

      expect(data.result).not.toBeNull();
      if (!data.result) {
        return;
      }

      expect(data.result.patchesPerRelease).toBeDefined();
      expect(Array.isArray(data.result.patchesPerRelease)).toBe(true);

      const versionLines = data.result.patchesPerRelease.map(
        (item) => item.version_line
      );

      expect(versionLines).toEqual(["0.5.x", "0.6.x", "0.9.x", "0.10.x"]);
    });
  });

  describe("Shared release cache", () => {
    // getReleases writes gh-fossbilling-releases - the same cache key the
    // versions service reads - so a stats-triggered fresh fetch must still
    // resolve the R2 mirror. Otherwise stats would overwrite that cache with
    // GitHub-only entries for up to 24h, silently undoing the R2 mirror for
    // clients that trust it. See FOSSBilling/FOSSBilling#2479.
    //
    // The cache stores both download_url (GitHub - always trusted) and
    // mirror_download_url (R2, when mirrored); which one a given FOSSBilling
    // install is actually sent is resolved per-request in the versions
    // service based on that client's own reported version, not baked into
    // this shared cache - see resolveReleaseForClient() there.
    it("resolves both the GitHub and R2 mirror URLs when it triggers the shared release fetch", async () => {
      // Mirroring began at 0.8.0 (R2_MIRROR_MIN_VERSION in versions/v1) -
      // nothing in the shared mockGitHubReleases fixture (which tops out at
      // 0.6.0) is eligible, so inject mockMirroredRelease on top of it.
      setupGitHubApiMock(
        vi.mocked(ghRequest) as MockGitHubRequest,
        vi.mocked(graphql) as unknown as MockGitHubGraphQL,
        [...mockGitHubReleases, mockMirroredRelease],
        mockComposerJson
      );
      await env.DOWNLOAD_BUCKET.put(
        "releases/0.8.0/FOSSBilling-0.8.0.zip",
        "mirrored archive contents",
        {
          customMetadata: {
            digest:
              "sha256:deadbeefcafe0000000000000000000000000000000000000000000000000000",
            version: "0.8.0"
          }
        }
      );

      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request("http://localhost/stats/v1/data", {
          headers: PUBLIC_HEADERS
        }),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);

      const cached = await env.CACHE_KV.get("gh-fossbilling-releases");
      expect(cached).toBeTruthy();
      const releases = JSON.parse(cached!);

      expect(releases["0.8.0"].download_url).toBe(
        "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.8.0/FOSSBilling.zip"
      );
      expect(releases["0.8.0"].mirror_download_url).toBe(
        "https://download.fossbilling.org/releases/0.8.0/FOSSBilling-0.8.0.zip"
      );
      expect(releases["0.8.0"].mirror_digest).toBe(
        "sha256:deadbeefcafe0000000000000000000000000000000000000000000000000000"
      );
    });
  });

  describe("GET /stats/v1/", () => {
    it("should return HTML page", async () => {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request("http://localhost/stats/v1"),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");

      const html = await response.text();
      expect(html).toContain("FOSSBilling Release Statistics");
      expect(html).toContain('id="releaseSizeChart"');
      expect(html).toContain('id="phpVersionChart"');
      expect(html).toContain('id="patchesChart"');
      expect(html).toContain('id="releasesPerYearChart"');
    });
  });
});
