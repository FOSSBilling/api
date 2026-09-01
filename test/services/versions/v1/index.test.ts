import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { compare as semverCompare } from "semver";
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
  setupGitHubApiMock,
  createGraphQLImplementation
} from "../../../utils/mock-helpers";
import {
  ApiResponse,
  ChangelogResponse,
  MockGitHubGraphQL,
  MockGitHubRequest,
  UpdateResponse,
  VersionInfo,
  VersionsResponse
} from "../../../utils/test-types";

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
import { resetUpdateTokenCache } from "../../../../src/services/versions/v1/index";

let restoreConsole: (() => void) | null = null;
let originalKVPut: typeof env.CACHE_KV.put | null = null;

describe("Versions API v1", () => {
  beforeEach(async () => {
    restoreConsole = suppressConsole();
    await env.CACHE_KV.delete("gh-fossbilling-releases");
    await env.DOWNLOAD_BUCKET.delete("releases/0.5.0/FOSSBilling-0.5.0.zip");
    await env.DOWNLOAD_BUCKET.delete("releases/0.6.0/FOSSBilling-0.6.0.zip");
    resetUpdateTokenCache();

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
    if (restoreConsole) {
      restoreConsole();
      restoreConsole = null;
    }
    if (originalKVPut) {
      env.CACHE_KV.put = originalKVPut;
      originalKVPut = null;
    }
  });

  describe("GET /", () => {
    it("should return all releases", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: VersionsResponse = await response.json();

      expect(data).toHaveProperty("result");
      expect(data).toHaveProperty("error_code", 0);
      expect(data).toHaveProperty("message", null);
      expect(typeof data.result).toBe("object");
      expect(Object.keys(data.result)).toContain("0.5.0");
      expect(Object.keys(data.result)).toContain("0.6.0");
    });

    it("should return releases sorted from latest to earliest", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: VersionsResponse = await response.json();

      const versionKeys = Object.keys(data.result);
      expect(versionKeys.length).toBeGreaterThan(1);

      for (let i = 0; i < versionKeys.length - 1; i++) {
        const current = versionKeys[i];
        const next = versionKeys[i + 1];
        const compare = semverCompare(current, next);
        expect(compare).toBeGreaterThanOrEqual(0);
      }
    });

    it("should include releases with versioned zip asset names", async () => {
      (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
        async (route: string) => {
          if (route === "GET /repos/{owner}/{repo}/releases") {
            return {
              data: [
                ...mockGitHubReleases,
                {
                  id: 1005,
                  tag_name: "0.8.0",
                  name: "0.8.0",
                  published_at: "2026-05-28T21:12:54Z",
                  prerelease: false,
                  body: "## 0.8.0\n- New release",
                  assets: [
                    {
                      name: "FOSSBilling-0.8.0.zip",
                      browser_download_url:
                        "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.8.0/FOSSBilling-0.8.0.zip",
                      size: 2048000
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

      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: VersionsResponse = await response.json();
      expect(data.result["0.8.0"]).toMatchObject({
        version: "0.8.0",
        download_url:
          "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.8.0/FOSSBilling-0.8.0.zip",
        size_bytes: 2048000
      });
    });

    it("should cache releases data", async () => {
      const ctx = createExecutionContext();
      await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const cached = await env.CACHE_KV.get("gh-fossbilling-releases");
      expect(cached).toBeTruthy();
      expect(typeof cached).toBe("string");
    });

    it("should return cached data on subsequent requests", async () => {
      const ctx1 = createExecutionContext();
      await app.request("/versions/v1", {}, env, ctx1);
      await waitOnExecutionContext(ctx1);

      (
        vi.mocked(ghRequest) as unknown as MockGitHubRequest
      ).mockRejectedValueOnce(new Error("API Error"));

      const ctx2 = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx2);
      await waitOnExecutionContext(ctx2);

      expect(response.status).toBe(200);
      const data: VersionsResponse = await response.json();
      expect(Object.keys(data.result)).toContain("0.5.0");
    });
  });

  describe("GET /latest", () => {
    it("should return the latest release", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/latest", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: ApiResponse<VersionInfo | null> = await response.json();

      expect(data).toHaveProperty("result");
      if (!data.result) {
        throw new Error("Expected latest release data");
      }
      expect(data.result.version).toBe("0.6.0");
      expect(data.result).toHaveProperty("released_on");
      expect(data.result).toHaveProperty("minimum_php_version");
      expect(data.result).toHaveProperty("download_url");
      expect(data.result).toHaveProperty("size_bytes");
      expect(data.result).toHaveProperty("is_prerelease", false);
      expect(data.result).toHaveProperty("github_release_id");
      expect(data.result).toHaveProperty("changelog");
      expect(data.result).toHaveProperty(
        "digest",
        "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      );
    });
  });

  describe("R2 release mirror", () => {
    // github.com has no AAAA record, so IPv6-only hosts must download
    // from the R2 mirror instead - see FOSSBilling/FOSSBilling#2479. But
    // only clients whose own version trusts download.fossbilling.org
    // (Update::$allowedDownloadPrefixes, added alongside the mirror itself)
    // should ever be sent that URL - anything older rejects it outright
    // with "Update canceled for security reasons" (the incident this
    // describe block guards against).
    async function mirrorRelease060() {
      await env.DOWNLOAD_BUCKET.put(
        "releases/0.6.0/FOSSBilling-0.6.0.zip",
        "mirrored archive contents",
        {
          customMetadata: {
            digest:
              "sha256:deadbeefcafe0000000000000000000000000000000000000000000000000000",
            version: "0.6.0"
          }
        }
      );
    }

    it("prefers the R2 mirror's download_url and digest for a client that trusts it", async () => {
      await mirrorRelease060();

      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/latest",
        { headers: { "User-Agent": "FOSSBilling/0.8.7" } },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Vary")).toContain("User-Agent");
      const data: ApiResponse<VersionInfo | null> = await response.json();
      if (!data.result) {
        throw new Error("Expected latest release data");
      }
      expect(data.result.download_url).toBe(
        "https://download.fossbilling.org/releases/0.6.0/FOSSBilling-0.6.0.zip"
      );
      expect(data.result.digest).toBe(
        "sha256:deadbeefcafe0000000000000000000000000000000000000000000000000000"
      );
    });

    it("falls back to the GitHub asset when a release hasn't been mirrored to R2", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/latest",
        { headers: { "User-Agent": "FOSSBilling/0.8.7" } },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: ApiResponse<VersionInfo | null> = await response.json();
      if (!data.result) {
        throw new Error("Expected latest release data");
      }
      expect(data.result.download_url).toBe(
        "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.6.0/FOSSBilling.zip"
      );
      expect(data.result.digest).toBe(
        "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      );
    });

    it("falls back to the GitHub asset for a client older than the mirror-trust cutoff, even when mirrored", async () => {
      await mirrorRelease060();

      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/latest",
        { headers: { "User-Agent": "FOSSBilling/0.8.6" } },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      const data: ApiResponse<VersionInfo | null> = await response.json();
      if (!data.result) {
        throw new Error("Expected latest release data");
      }
      expect(data.result.download_url).toBe(
        "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.6.0/FOSSBilling.zip"
      );
      expect(data.result.digest).toBe(
        "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
      );
    });

    it("falls back to the GitHub asset for a client sending no User-Agent, even when mirrored", async () => {
      // Versions <=0.8.3 predate FOSSBilling's own User-Agent header entirely
      // (added in 0.8.4) and send none of their own.
      await mirrorRelease060();

      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/latest", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      const data: ApiResponse<VersionInfo | null> = await response.json();
      if (!data.result) {
        throw new Error("Expected latest release data");
      }
      expect(data.result.download_url).toBe(
        "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.6.0/FOSSBilling.zip"
      );
    });

    it("falls back to the GitHub asset for an unparseable User-Agent, even when mirrored", async () => {
      await mirrorRelease060();

      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/latest",
        { headers: { "User-Agent": "curl/8.0.0" } },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      const data: ApiResponse<VersionInfo | null> = await response.json();
      if (!data.result) {
        throw new Error("Expected latest release data");
      }
      expect(data.result.download_url).toBe(
        "https://github.com/FOSSBilling/FOSSBilling/releases/download/0.6.0/FOSSBilling.zip"
      );
    });

    it("never exposes the internal mirror_download_url/mirror_digest fields in the response", async () => {
      await mirrorRelease060();

      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/latest",
        { headers: { "User-Agent": "FOSSBilling/0.8.7" } },
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      const data: ApiResponse<VersionInfo | null> = await response.json();
      expect(data.result).not.toHaveProperty("mirror_download_url");
      expect(data.result).not.toHaveProperty("mirror_digest");
    });
  });

  describe("GET /:version", () => {
    it("should return specific version", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/0.5.0", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: ApiResponse<VersionInfo | null> = await response.json();

      expect(data).toHaveProperty("result");
      if (!data.result) {
        throw new Error("Expected version info for 0.5.0");
      }
      expect(data.result).toHaveProperty("version", "0.5.0");
      // 0.5.0's mock asset predates GitHub's asset-digest feature.
      expect(data.result).toHaveProperty("digest", null);
    });

    it("should return 404 for non-existent version", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/999.999.999",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
      const data: ApiResponse<VersionInfo | null> = await response.json();

      expect(data.result).toBe(null);
      expect(data).toHaveProperty("error_code", 404);
      expect(data.message).toContain("does not appear to exist");
    });

    it("should handle 'latest' alias", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/latest", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: ApiResponse<VersionInfo | null> = await response.json();

      if (!data.result) {
        throw new Error("Expected version info for latest");
      }
      expect(data.result.version).toBe("0.6.0");
    });
  });

  describe("GET /build_changelog/:current", () => {
    it("should build changelog for current version", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/build_changelog/0.5.0",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: ChangelogResponse = await response.json();

      expect(data).toHaveProperty("result");
      expect(data).toHaveProperty("error_code", 0);
      expect(typeof data.result).toBe("string");
      expect(data.result).toContain("## 0.6.0");
    });

    it("should return empty changelog for latest version", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/build_changelog/0.6.0",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: ChangelogResponse = await response.json();

      expect(data.result).toBe("");
    });

    it("should return 400 for invalid version", async () => {
      const ctx = createExecutionContext();
      const response = await app.request(
        "/versions/v1/build_changelog/invalid",
        {},
        env,
        ctx
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(400);
      const data: ChangelogResponse = await response.json();

      expect(data).toHaveProperty("result", null);
      expect(data).toHaveProperty("error_code", 400);
      expect(data.message).toContain("not a valid semantic version");
    });
  });

  describe("GET /count", () => {
    it("should return the total count of releases", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/count", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: ApiResponse<number | null> = await response.json();

      expect(data).toHaveProperty("result");
      expect(typeof data.result).toBe("number");
      expect(data.result).toBeGreaterThan(0);
      expect(data).toHaveProperty("error_code", 0);
      expect(data).toHaveProperty("message", null);
    });

    it("should serve cached count when available", async () => {
      const ctx1 = createExecutionContext();
      await app.request("/versions/v1", {}, env, ctx1);
      await waitOnExecutionContext(ctx1);

      // Make a second request - should use cache
      const ctx2 = createExecutionContext();
      const response = await app.request("/versions/v1/count", {}, env, ctx2);
      await waitOnExecutionContext(ctx2);

      expect(response.status).toBe(200);
      const data: ApiResponse<number | null> = await response.json();
      expect(data.result).toBeGreaterThan(0);
    });
  });

  describe("GET /update", () => {
    it("should update cache when authenticated", async () => {
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
      const data: UpdateResponse = await response.json();

      expect(data).toHaveProperty("result");
      expect(data.result).toContain("Releases cache updated successfully");
      expect(data).toHaveProperty("error_code", 0);
    });

    it("should return 401 when not authenticated", async () => {
      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/update", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
    });

    it("should return 401 with wrong token", async () => {
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

    it("should stop accepting a rotated token after the token cache TTL", async () => {
      const now = Date.now();
      const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);

      try {
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

        await env.AUTH_KV.put("UPDATE_TOKEN", "rotated-update-token-12345");

        const ctx2 = createExecutionContext();
        const response2 = await app.request(
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
        expect(response2.status).toBe(200);

        dateNow.mockReturnValue(now + 60_001);

        const ctx3 = createExecutionContext();
        const response3 = await app.request(
          "/versions/v1/update",
          {
            headers: {
              Authorization: "Bearer test-update-token-12345"
            }
          },
          env,
          ctx3
        );
        await waitOnExecutionContext(ctx3);
        expect(response3.status).toBe(401);

        const ctx4 = createExecutionContext();
        const response4 = await app.request(
          "/versions/v1/update",
          {
            headers: {
              Authorization: "Bearer rotated-update-token-12345"
            }
          },
          env,
          ctx4
        );
        await waitOnExecutionContext(ctx4);
        expect(response4.status).toBe(200);
      } finally {
        dateNow.mockRestore();
      }
    });
  });

  describe("Error Handling", () => {
    it("should handle GitHub API errors gracefully", async () => {
      (vi.mocked(ghRequest) as MockGitHubRequest).mockRejectedValueOnce(
        new Error("GitHub API Error")
      );

      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(503);
      const data: VersionsResponse = await response.json();
      expect(data.error_code).toBe(503);
      expect(data.message).toContain("Unable to fetch releases");
    });

    it("should handle missing composer.json", async () => {
      // All blobs return null (no composer.json found for any release)
      (vi.mocked(graphql) as unknown as MockGitHubGraphQL).mockImplementation(
        createGraphQLImplementation(null)
      );

      const ctx = createExecutionContext();
      const response = await app.request("/versions/v1/0.5.0", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const data: ApiResponse<VersionInfo | null> = await response.json();

      if (!data.result) {
        throw new Error("Expected version info for 0.5.0");
      }
      expect(data.result).toHaveProperty("version", "0.5.0");
      expect(data.result.minimum_php_version).toBe("");
    });

    describe("Empty releases cache retry logic", () => {
      it("should retry with updateCache when releases is empty", async () => {
        let callCount = 0;
        (
          vi.mocked(ghRequest) as unknown as MockGitHubRequest
        ).mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return { data: [] };
          }
          return { data: mockGitHubReleases };
        });

        const ctx = createExecutionContext();
        const response = await app.request("/versions/v1/0.6.0", {}, env, ctx);
        await waitOnExecutionContext(ctx);

        expect(response.status).toBe(200);
        const data: ApiResponse<VersionInfo | null> = await response.json();

        if (!data.result) {
          throw new Error("Expected version info for 0.6.0");
        }
        expect(data.result.version).toBe("0.6.0");

        // 1 call for empty releases list + 1 call for retry releases list.
        // PHP versions are now fetched via a single GraphQL fetch call, not ghRequest.
        expect(vi.mocked(ghRequest)).toHaveBeenCalledTimes(2);
      });

      it("should return 404 when retry also fails", async () => {
        (vi.mocked(ghRequest) as MockGitHubRequest).mockRejectedValueOnce(
          new Error("GitHub API Error")
        );
        (vi.mocked(ghRequest) as MockGitHubRequest).mockRejectedValueOnce(
          new Error("GitHub API Error")
        );

        const ctx = createExecutionContext();
        const response = await app.request("/versions/v1/0.6.0", {}, env, ctx);
        await waitOnExecutionContext(ctx);

        expect(response.status).toBe(503);
        const data: ApiResponse<VersionInfo | null> = await response.json();

        expect(data.result).toBeNull();
        expect(data.error_code).toBe(503);
        expect(data.message).toContain("Unable to fetch releases");

        expect(vi.mocked(ghRequest)).toHaveBeenCalledTimes(2);
      });

      it("should return 404 for 'latest' when retry fails", async () => {
        (vi.mocked(ghRequest) as MockGitHubRequest).mockRejectedValueOnce(
          new Error("GitHub API Error")
        );
        (vi.mocked(ghRequest) as MockGitHubRequest).mockRejectedValueOnce(
          new Error("GitHub API Error")
        );

        const ctx = createExecutionContext();
        const response = await app.request("/versions/v1/latest", {}, env, ctx);
        await waitOnExecutionContext(ctx);

        expect(response.status).toBe(503);
        const data: ApiResponse<VersionInfo | null> = await response.json();

        expect(data.result).toBeNull();
        expect(data.error_code).toBe(503);
        expect(data.message).toContain("Unable to fetch releases");

        expect(vi.mocked(ghRequest)).toHaveBeenCalledTimes(2);
      });

      it("should succeed after retry with 'latest' alias", async () => {
        let callCount = 0;
        (
          vi.mocked(ghRequest) as unknown as MockGitHubRequest
        ).mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return { data: [] };
          }
          return { data: mockGitHubReleases };
        });

        const ctx = createExecutionContext();
        const response = await app.request("/versions/v1/latest", {}, env, ctx);
        await waitOnExecutionContext(ctx);

        expect(response.status).toBe(200);
        const data: ApiResponse<VersionInfo | null> = await response.json();

        if (!data.result) {
          throw new Error("Expected latest release");
        }
        expect(data.result.version).toBe("0.6.0");

        // 1 call for empty releases list + 1 call for retry releases list.
        // PHP versions are now fetched via a single GraphQL fetch call, not ghRequest.
        expect(vi.mocked(ghRequest)).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("Caching", () => {
    it("should respect cache TTL", async () => {
      const cachePutArgs: [string, string, { expirationTtl: number }?][] = [];
      originalKVPut = env.CACHE_KV.put;
      env.CACHE_KV.put = vi
        .fn()
        .mockImplementation(
          (key: string, value: string, options?: { expirationTtl: number }) => {
            cachePutArgs.push([key, value, options]);
            return originalKVPut!.call(env.CACHE_KV, key, value, options);
          }
        );

      const ctx = createExecutionContext();
      await app.request("/versions/v1", {}, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(env.CACHE_KV.put).toHaveBeenCalled();
      const putCall = cachePutArgs.find(
        (args) => args[0] === "gh-fossbilling-releases"
      );
      expect(putCall).toBeTruthy();
      expect(putCall![2]!).toHaveProperty("expirationTtl", 86400);
    });
  });
});
