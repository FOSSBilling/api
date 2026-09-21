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

const PR_NUMBER = 123;
const SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

const SAMPLE_ARTIFACTS = {
  total_count: 1,
  artifacts: [
    {
      id: 555,
      size_in_bytes: 12345,
      created_at: "2026-08-13T10:00:00Z",
      expires_at: "2026-08-27T10:00:00Z",
      expired: false,
      digest: "sha256:deadbeef",
      workflow_run: { id: 999, head_sha: SHA }
    }
  ]
};

function mockGithub(routes: Record<string, unknown>) {
  (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
    async (route: string) => {
      if (route in routes) return routes[route];
      throw new Error(`Unexpected route: ${route}`);
    }
  );
}

async function get(path: string) {
  const ctx = createExecutionContext();
  const res = await app.request(path, {}, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let restoreConsole: (() => void) | null = null;

describe("Previews API v1 - GET /previews/v1/pr/:number", () => {
  beforeEach(async () => {
    restoreConsole = suppressConsole();
    await env.CACHE_KV.delete(`preview:pr:${PR_NUMBER}`);
    // The PR route now shares the commit-keyed cache entry for its head
    // SHA (see resolvePrPreview), so a negative/positive entry left by an
    // earlier test's mocks must not leak into this one.
    await env.CACHE_KV.delete(`preview:commit:${SHA.toLowerCase()}`);
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreConsole?.();
    restoreConsole = null;
  });

  it("resolves the PR to its head SHA, then to that commit's artifact", async () => {
    mockGithub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        data: { head: { sha: SHA } }
      },
      "GET /repos/{owner}/{repo}/actions/artifacts": { data: SAMPLE_ARTIFACTS }
    });

    const res = await get(`/previews/v1/pr/${PR_NUMBER}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        commit_sha: string;
        pr_number: number | null;
        download_url: string;
      };
    };
    expect(body.result.commit_sha).toBe(SHA);
    expect(body.result.pr_number).toBe(PR_NUMBER);
    // Always canonicalized to the fixed /commit/{sha} resource, not
    // /pr/{number} - see resolve.ts.
    expect(body.result.download_url).toBe(
      `/previews/v1/commit/${SHA}/download`
    );
  });

  it("404s when the pull request does not exist", async () => {
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    const res = await get(`/previews/v1/pr/${PR_NUMBER}`);
    expect(res.status).toBe(404);
  });

  it("404s when the PR exists but has no preview artifact yet", async () => {
    mockGithub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        data: { head: { sha: SHA } }
      },
      "GET /repos/{owner}/{repo}/actions/artifacts": {
        data: { total_count: 0, artifacts: [] }
      },
      "GET /repos/{owner}/{repo}/actions/runs": {
        data: { total_count: 0, workflow_runs: [] }
      }
    });

    const res = await get(`/previews/v1/pr/${PR_NUMBER}`);
    expect(res.status).toBe(404);
  });

  it("422s on a non-numeric PR number", async () => {
    const res = await get("/previews/v1/pr/not-a-number");
    expect(res.status).toBe(422);
  });

  it("follows the redirect for /pr/:number/download", async () => {
    mockGithub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        data: { head: { sha: SHA } }
      },
      "GET /repos/{owner}/{repo}/actions/artifacts": {
        data: SAMPLE_ARTIFACTS
      },
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}":
        {
          status: 302,
          headers: { location: "https://example.com/signed-download" }
        }
    });

    const res = await get(`/previews/v1/pr/${PR_NUMBER}/download`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://example.com/signed-download"
    );
  });

  it("shares the metadata route's cache instead of re-resolving the PR on every download", async () => {
    let pullsCalls = 0;
    let artifactsListCalls = 0;
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          pullsCalls++;
          return { data: { head: { sha: SHA } } };
        }
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

    await get(`/previews/v1/pr/${PR_NUMBER}`);
    const res = await get(`/previews/v1/pr/${PR_NUMBER}/download`);

    expect(res.status).toBe(302);
    // Both the PR->SHA resolution and the artifact lookup ran once,
    // warming the cache on the first request - the download request
    // reused that instead of re-resolving the PR from scratch.
    expect(pullsCalls).toBe(1);
    expect(artifactsListCalls).toBe(1);
  });

  it("caches the PR lookup at the default 60s, unlike commit's longer TTL", async () => {
    mockGithub({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        data: { head: { sha: SHA } }
      },
      "GET /repos/{owner}/{repo}/actions/artifacts": { data: SAMPLE_ARTIFACTS }
    });
    const putSpy = vi.spyOn(env.CACHE_KV, "put");

    await get(`/previews/v1/pr/${PR_NUMBER}`);

    expect(putSpy).toHaveBeenCalledWith(
      `preview:pr:${PR_NUMBER}`,
      expect.any(String),
      { expirationTtl: 60 }
    );
    putSpy.mockRestore();
  });

  it("shares the commit-keyed entry with /commit/{sha} in both directions", async () => {
    // Same reason commit.test.ts uses a far-future expiry: an artifact
    // whose retention has lapsed must not be cached under the commit key
    // (ttlForArtifact goes negative), which would defeat what this test
    // verifies.
    const liveArtifact = {
      ...SAMPLE_ARTIFACTS.artifacts[0],
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    };
    let artifactsListCalls = 0;
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async (route: string) => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return { data: { head: { sha: SHA } } };
        }
        if (route === "GET /repos/{owner}/{repo}/actions/artifacts") {
          artifactsListCalls++;
          return { data: { total_count: 1, artifacts: [liveArtifact] } };
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    );

    await get(`/previews/v1/pr/${PR_NUMBER}`);
    expect(artifactsListCalls).toBe(1);

    // The canonical /commit/{sha} form (what download_url points clients
    // at) reuses the entry the PR resolve wrote under the commit key -
    // no second GitHub resolve chain within the window.
    const commitRes = await get(`/previews/v1/commit/${SHA}`);
    expect(commitRes.status).toBe(200);
    const commitBody = (await commitRes.json()) as {
      result: { pr_number: number | null };
    };
    expect(commitBody.result.pr_number).toBeNull();
    expect(artifactsListCalls).toBe(1);

    // While the PR view of the same artifact keeps the PR's own number.
    const prRes = await get(`/previews/v1/pr/${PR_NUMBER}`);
    const prBody = (await prRes.json()) as {
      result: { pr_number: number | null };
    };
    expect(prBody.result.pr_number).toBe(PR_NUMBER);
  });

  it("resolves a fork PR whose artifact was named from the merge SHA, not the head SHA", async () => {
    // ci.yml's pull_request-triggered job (fork PRs only) names its
    // artifact after $GITHUB_SHA, which GitHub sets to the ephemeral
    // pull_request merge commit rather than the PR's real head commit -
    // see the comment on findPreviewArtifactByCommitSha. The exact-name
    // query built from the real head SHA (SHA) therefore misses, and the
    // full-SHA runs-API fallback (matched by the run's real head_sha,
    // unaffected by what name the artifact was given) finds it.
    const mergeShaArtifact = {
      id: 777,
      name: "FOSSBilling-preview-deadbee.zip",
      size_in_bytes: 99,
      created_at: "2026-08-13T11:00:00Z",
      expires_at: "2026-08-27T11:00:00Z",
      expired: false,
      digest: "sha256:fromfork",
      workflow_run: { id: 888, head_sha: SHA }
    };
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async (route: string, params?: { name?: string }) => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return { data: { head: { sha: SHA } } };
        }
        if (route === "GET /repos/{owner}/{repo}/actions/artifacts") {
          if (params?.name) {
            return { data: { total_count: 0, artifacts: [] } };
          }
          return { data: { total_count: 1, artifacts: [mergeShaArtifact] } };
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
          return { data: { total_count: 1, artifacts: [mergeShaArtifact] } };
        }
        throw new Error(`Unexpected route: ${route}`);
      }
    );

    const res = await get(`/previews/v1/pr/${PR_NUMBER}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { artifact_id: number; pr_number: number | null };
    };
    expect(body.result.artifact_id).toBe(777);
    expect(body.result.pr_number).toBe(PR_NUMBER);
  });
});
