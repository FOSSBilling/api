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
});
