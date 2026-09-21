import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../../src/app";
import { MockGitHubRequest } from "../../../utils/test-types";
import { suppressConsole } from "../../../utils/mock-helpers";

vi.mock("@octokit/request", async () =>
  (await import("../../../mocks/octokit")).octokitRequestMock()
);

import { request as ghRequest } from "@octokit/request";

const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

// A fixed calendar date here would eventually land in the past and make
// ttlForArtifact() compute a negative TTL, silently disabling the caching
// these tests exist to verify - GitHub's own artifact retention is 14
// days, so anything comfortably longer reads as "not expiring any time
// soon" for as long as this suite keeps running.
const FAR_FUTURE_EXPIRES_AT = new Date(
  Date.now() + 365 * 24 * 60 * 60 * 1000
).toISOString();

const SAMPLE_ARTIFACTS = {
  total_count: 1,
  artifacts: [
    {
      id: 555,
      size_in_bytes: 12345,
      created_at: "2026-08-13T10:00:00Z",
      expires_at: FAR_FUTURE_EXPIRES_AT,
      expired: false,
      digest: "sha256:deadbeef",
      workflow_run: { id: 999, head_sha: SHA }
    }
  ]
};

async function get(path: string) {
  const ctx = createExecutionContext();
  const res = await app.request(path, {}, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let restoreConsole: (() => void) | null = null;

describe("Previews API v1 - GET /previews/v1/commit/:sha", () => {
  beforeEach(async () => {
    restoreConsole = suppressConsole();
    await env.CACHE_KV.delete(`preview:commit:${SHA.toLowerCase()}`);
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreConsole?.();
    restoreConsole = null;
  });

  it("returns the matching artifact's metadata", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/actions/artifacts") {
          return { data: SAMPLE_ARTIFACTS };
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    );

    const res = await get(`/previews/v1/commit/${SHA}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        commit_sha: string;
        short_sha: string;
        pr_number: number | null;
        run_id: number;
        artifact_id: number;
        digest: string | null;
        download_url: string;
        source: string;
      };
    };
    expect(body.result.commit_sha).toBe(SHA);
    expect(body.result.short_sha).toBe(SHA.slice(0, 7));
    expect(body.result.pr_number).toBeNull();
    expect(body.result.run_id).toBe(999);
    expect(body.result.artifact_id).toBe(555);
    expect(body.result.digest).toBe("sha256:deadbeef");
    expect(body.result.download_url).toBe(
      `/previews/v1/commit/${SHA}/download`
    );
    expect(body.result.source).toBe("actions_artifact");

    // Regression check: FOSSBilling/FOSSBilling's ci.yml names each
    // artifact after the commit's short SHA rather than sharing one name
    // across every run - querying the wrong name silently returns nothing.
    expect(ghRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/artifacts",
      expect.objectContaining({
        name: `FOSSBilling-preview-${SHA.slice(0, 7)}.zip`
      })
    );
  });

  it("matches on a short SHA prefix", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({ data: SAMPLE_ARTIFACTS })
    );

    const res = await get(`/previews/v1/commit/${SHA.slice(0, 7)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { commit_sha: string } };
    expect(body.result.commit_sha).toBe(SHA);
  });

  it("ignores expired artifacts", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({
        data: {
          total_count: 1,
          artifacts: [{ ...SAMPLE_ARTIFACTS.artifacts[0], expired: true }]
        }
      })
    );

    const res = await get(`/previews/v1/commit/${SHA}`);
    expect(res.status).toBe(404);
  });

  it("404s when no artifact matches the commit", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({ data: { total_count: 0, artifacts: [] } })
    );

    const res = await get(`/previews/v1/commit/${SHA}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("422s on a malformed sha", async () => {
    const res = await get("/previews/v1/commit/not-a-sha");
    expect(res.status).toBe(422);
  });

  it("returns 503 when GitHub is unavailable", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(async () => {
      throw Object.assign(new Error("Service Unavailable"), {
        status: 502
      });
    });

    const res = await get(`/previews/v1/commit/${SHA}`);
    expect(res.status).toBe(503);
  });

  it("follows the redirect for /commit/:sha/download", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/actions/artifacts") {
          return { data: SAMPLE_ARTIFACTS };
        }
        if (
          route ===
          "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}"
        ) {
          return {
            status: 302,
            headers: { location: "https://example.com/signed-download" }
          };
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    );

    const res = await get(`/previews/v1/commit/${SHA}/download`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://example.com/signed-download"
    );
  });

  it("shares the metadata route's cache instead of re-listing artifacts on every download", async () => {
    let artifactsListCalls = 0;
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/actions/artifacts") {
          artifactsListCalls++;
          return { data: SAMPLE_ARTIFACTS };
        }
        if (
          route ===
          "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}"
        ) {
          return {
            status: 302,
            headers: { location: "https://example.com/signed-download" }
          };
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    );

    await get(`/previews/v1/commit/${SHA}`);
    const res = await get(`/previews/v1/commit/${SHA}/download`);

    expect(res.status).toBe(302);
    // The artifact lookup ran once (warming the cache on the first
    // request) - the download request reused it rather than listing
    // artifacts again just to find the same artifact_id.
    expect(artifactsListCalls).toBe(1);
  });

  it("caches the commit lookup for longer than the default 60s", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({ data: SAMPLE_ARTIFACTS })
    );
    const putSpy = vi.spyOn(env.CACHE_KV, "put");

    await get(`/previews/v1/commit/${SHA}`);

    expect(putSpy).toHaveBeenCalledWith(
      `preview:commit:${SHA.toLowerCase()}`,
      expect.any(String),
      { expirationTtl: 3600 }
    );
    putSpy.mockRestore();
  });

  it("caps the cache TTL at the artifact's own remaining GitHub retention", async () => {
    // Expires in ~500s - well under the 3600s default, so the capped
    // value (not 3600) must be what's actually written.
    const expiresAt = new Date(Date.now() + 500_000).toISOString();
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({
        data: {
          total_count: 1,
          artifacts: [
            { ...SAMPLE_ARTIFACTS.artifacts[0], expires_at: expiresAt }
          ]
        }
      })
    );
    const putSpy = vi.spyOn(env.CACHE_KV, "put");

    await get(`/previews/v1/commit/${SHA}`);

    expect(putSpy).toHaveBeenCalledTimes(1);
    const ttl = (putSpy.mock.calls[0][2] as { expirationTtl: number })
      .expirationTtl;
    expect(ttl).toBeGreaterThan(400);
    expect(ttl).toBeLessThanOrEqual(500);
    putSpy.mockRestore();
  });

  it("skips caching when the artifact expires within KV's 60s minimum TTL", async () => {
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({
        data: {
          total_count: 1,
          artifacts: [
            { ...SAMPLE_ARTIFACTS.artifacts[0], expires_at: expiresAt }
          ]
        }
      })
    );
    const putSpy = vi.spyOn(env.CACHE_KV, "put");

    const res = await get(`/previews/v1/commit/${SHA}`);

    expect(res.status).toBe(200);
    expect(putSpy).not.toHaveBeenCalled();
    putSpy.mockRestore();
  });

  it("resolves an uppercase SHA by querying the lowercased artifact name", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({ data: SAMPLE_ARTIFACTS })
    );

    const res = await get(`/previews/v1/commit/${SHA.toUpperCase()}`);

    expect(res.status).toBe(200);
    expect(ghRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/artifacts",
      expect.objectContaining({
        name: `FOSSBilling-preview-${SHA.slice(0, 7)}.zip`
      })
    );
  });

  it("falls back to the runs API when the exact artifact name misses (fork PR merge-SHA mismatch)", async () => {
    // Simulates a fork PR: CI named the artifact after the pull_request
    // event's ephemeral merge commit ("deadbeef..."), not the PR's real
    // head SHA (SHA) - so the exact-name query for SHA's derived name
    // returns nothing, and the full-SHA fallback (runs filtered
    // server-side by head_sha, then that run's artifacts) finds it.
    const mergeShaArtifact = {
      id: 777,
      name: "FOSSBilling-preview-deadbee.zip",
      size_in_bytes: 99,
      created_at: "2026-08-13T11:00:00Z",
      expires_at: FAR_FUTURE_EXPIRES_AT,
      expired: false,
      digest: "sha256:fromfork",
      workflow_run: { id: 888, head_sha: SHA }
    };
    // preview-build.yml also uploads an unprefixed "preview-build"
    // artifact (a build.tar, not the zip) on the same run; it must never
    // be returned as the preview just because its head_sha matches.
    const genericRunArtifact = {
      id: 778,
      name: "preview-build",
      size_in_bytes: 123456,
      created_at: "2026-08-13T11:30:00Z",
      expires_at: FAR_FUTURE_EXPIRES_AT,
      expired: false,
      digest: "sha256:generic",
      workflow_run: { id: 888, head_sha: SHA }
    };
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async (route: string, params?: { name?: string }) => {
        if (route === "GET /repos/{owner}/{repo}/actions/artifacts") {
          if (params?.name) {
            // The exact-name fast path - misses.
            return { data: { total_count: 0, artifacts: [] } };
          }
          throw new Error("Unexpected name-less artifact list call");
        }
        if (route === "GET /repos/{owner}/{repo}/actions/runs") {
          return {
            data: {
              total_count: 1,
              workflow_runs: [{ id: 888, head_sha: SHA }]
            }
          };
        }
        if (
          route === "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts"
        ) {
          return {
            data: {
              total_count: 2,
              artifacts: [genericRunArtifact, mergeShaArtifact]
            }
          };
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    );

    const res = await get(`/previews/v1/commit/${SHA}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { artifact_id: number; digest: string | null };
    };
    expect(body.result.artifact_id).toBe(777);
    expect(body.result.digest).toBe("sha256:fromfork");
    // Exact-name list + runs list + that run's artifacts.
    expect(ghRequest).toHaveBeenCalledTimes(3);
    expect(ghRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/runs",
      expect.objectContaining({ head_sha: SHA })
    );
  });
  it("pages through the short-SHA fallback scan past the old 5-page cap, then stops as soon as it finds a match", async () => {
    // Regression check: an earlier version of the page-scan fallback
    // stopped after 5 pages (500 artifacts) as a hard cutoff, which would
    // have reported this commit not_found even though its artifact
    // genuinely exists - just on page 6. Short SHAs can't use the
    // runs-API fallback (GitHub matches head_sha exactly), so they still
    // page the repo-wide artifact list, and that scan must not trade
    // correctness for a fixed cutoff.
    const shortSha = SHA.slice(0, 7);
    await env.CACHE_KV.delete(`preview:commit:${shortSha}`);
    const fullPage = (offset: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        id: offset + i,
        name: `FOSSBilling-preview-other${offset + i}.zip`,
        size_in_bytes: 1,
        created_at: "2026-08-01T00:00:00Z",
        expires_at: "2026-08-15T00:00:00Z",
        expired: false,
        digest: null,
        workflow_run: {
          id: 1,
          head_sha: "0000000000000000000000000000000000000"
        }
      }));
    const page6Match = {
      id: 9000,
      name: "FOSSBilling-preview-deadbee.zip",
      size_in_bytes: 99,
      created_at: "2026-08-13T11:00:00Z",
      expires_at: FAR_FUTURE_EXPIRES_AT,
      expired: false,
      digest: "sha256:page6",
      workflow_run: { id: 888, head_sha: SHA }
    };
    let fallbackCalls = 0;
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async (route: string, params?: { name?: string; page?: number }) => {
        if (route !== "GET /repos/{owner}/{repo}/actions/artifacts") {
          throw new Error(`Unexpected route: ${route}`);
        }
        if (params?.name) {
          return { data: { total_count: 0, artifacts: [] } };
        }
        fallbackCalls++;
        const page = params?.page ?? 1;
        if (page <= 5) {
          return { data: { artifacts: fullPage(page * 1000) } };
        }
        if (page === 6) {
          return { data: { artifacts: [page6Match] } };
        }
        throw new Error(`Unexpected page: ${page}`);
      }
    );

    const res = await get(`/previews/v1/commit/${shortSha}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { artifact_id: number } };
    expect(body.result.artifact_id).toBe(9000);
    // Exact-name miss + 6 fallback pages - stops on page 6 rather than
    // continuing to page 7.
    expect(fallbackCalls).toBe(6);
    expect(ghRequest).toHaveBeenCalledTimes(7);
  });

  it("falls back to the default TTL ceiling when expires_at can't be parsed", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({
        data: {
          total_count: 1,
          artifacts: [{ ...SAMPLE_ARTIFACTS.artifacts[0], expires_at: null }]
        }
      })
    );
    const putSpy = vi.spyOn(env.CACHE_KV, "put");

    const res = await get(`/previews/v1/commit/${SHA}`);

    expect(res.status).toBe(200);
    expect(putSpy).toHaveBeenCalledWith(
      `preview:commit:${SHA.toLowerCase()}`,
      expect.any(String),
      { expirationTtl: 3600 }
    );
    putSpy.mockRestore();
  });
});
