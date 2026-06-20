import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
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
import type { StatsData } from "../../../../src/services/stats/v1/interfaces";

import { request as ghRequest } from "@octokit/request";
import { graphql } from "@octokit/graphql";

interface StatsApiResponse {
  result: StatsData | null;
  error_code: number;
  message: string | null;
  stale?: boolean;
  details?: {
    http_status?: number;
    error_code?: string;
  };
}

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

let restoreConsole: (() => void) | null = null;

describe("Stats API v1", () => {
  beforeEach(async () => {
    restoreConsole = suppressConsole();
    await env.CACHE_KV.delete("gh-fossbilling-releases");
    await env.CACHE_KV.delete("fossbilling-stats-data");

    const testUpdateToken = "test-update-token-12345";
    await env.AUTH_KV.put("UPDATE_TOKEN", testUpdateToken);

    vi.clearAllMocks();
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

  describe("GET /stats/v1/data", () => {
    it("should return aggregated statistics", async () => {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request("http://localhost/stats/v1/data"),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as StatsApiResponse;

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
      const data1 = (await response1.json()) as StatsApiResponse;

      const ctx2 = createExecutionContext();
      const response2 = await app.fetch(
        new Request("http://localhost/stats/v1/data"),
        env,
        ctx2
      );
      await waitOnExecutionContext(ctx2);

      expect(response2.status).toBe(200);
      const data2 = (await response2.json()) as StatsApiResponse;

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
        new Request("http://localhost/stats/v1/data"),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as StatsApiResponse;

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
        new Request("http://localhost/stats/v1/data"),
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data = (await response.json()) as StatsApiResponse;

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
      expect(html).toContain('src="https://cdn.jsdelivr.net/npm/chart.js@');
    });
  });
});
