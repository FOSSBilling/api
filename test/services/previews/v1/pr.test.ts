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
});
