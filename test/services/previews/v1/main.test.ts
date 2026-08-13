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

const MAIN_PREVIEW_KEY = "FOSSBilling-preview.zip";
const COMMIT_SHA = "abc1234567890abc1234567890abc1234567890";

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
      workflow_run: { id: 999, head_sha: COMMIT_SHA }
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

describe("Previews API v1 - GET /previews/v1/main", () => {
  beforeEach(async () => {
    restoreConsole = suppressConsole();
    await env.CACHE_KV.delete("preview:main");
    await env.PREVIEW_BUCKET.delete(MAIN_PREVIEW_KEY);
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreConsole?.();
    restoreConsole = null;
  });

  it("returns 404 when no main preview has been published", async () => {
    const res = await get("/previews/v1/main");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns the R2 object's metadata, including the sha256 digest", async () => {
    await env.PREVIEW_BUCKET.put(MAIN_PREVIEW_KEY, "test archive contents", {
      customMetadata: {
        digest:
          "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "commit-sha": COMMIT_SHA
      }
    });

    const res = await get("/previews/v1/main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        commit_sha: string | null;
        short_sha: string | null;
        digest: string | null;
        size_bytes: number;
        download_url: string;
        source: string;
      };
    };

    expect(body.result.commit_sha).toBe(COMMIT_SHA);
    expect(body.result.short_sha).toBe("abc1234");
    expect(body.result.digest).toBe(
      "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    );
    expect(body.result.size_bytes).toBe("test archive contents".length);
    expect(body.result.download_url).toBe(
      "https://download.fossbilling.org/FOSSBilling-preview.zip"
    );
    expect(body.result.source).toBe("r2");
  });

  it("reports a null digest and commit_sha when the object has no custom metadata", async () => {
    await env.PREVIEW_BUCKET.put(MAIN_PREVIEW_KEY, "test archive contents");

    const res = await get("/previews/v1/main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        commit_sha: string | null;
        digest: string | null;
        run_id: number | null;
      };
    };
    expect(body.result.commit_sha).toBeNull();
    expect(body.result.digest).toBeNull();
    // No commit_sha means there's nothing to look up an artifact by.
    expect(body.result.run_id).toBeNull();
    expect(ghRequest).not.toHaveBeenCalled();
  });

  it("enriches with that commit's GitHub Actions artifact when resolvable", async () => {
    await env.PREVIEW_BUCKET.put(MAIN_PREVIEW_KEY, "test archive contents", {
      customMetadata: { "commit-sha": COMMIT_SHA }
    });
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({ data: SAMPLE_ARTIFACTS })
    );

    const res = await get("/previews/v1/main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        pr_number: number | null;
        run_id: number | null;
        artifact_id: number | null;
        created_at: string | null;
        expires_at: string | null;
        source: string;
      };
    };
    expect(body.result.pr_number).toBeNull();
    expect(body.result.run_id).toBe(999);
    expect(body.result.artifact_id).toBe(555);
    expect(body.result.created_at).toBe("2026-08-13T10:00:00Z");
    expect(body.result.expires_at).toBe("2026-08-27T10:00:00Z");
    // download_url/digest stay R2-sourced regardless of the enrichment.
    expect(body.result.source).toBe("r2");
  });

  it("still succeeds with null enrichment fields when GitHub is unavailable", async () => {
    await env.PREVIEW_BUCKET.put(MAIN_PREVIEW_KEY, "test archive contents", {
      customMetadata: { "commit-sha": COMMIT_SHA }
    });
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(async () => {
      throw Object.assign(new Error("Service Unavailable"), {
        status: 502
      });
    });

    const res = await get("/previews/v1/main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { run_id: number | null; digest: string | null };
    };
    expect(body.result.run_id).toBeNull();
  });

  it("still succeeds with null enrichment fields when the commit has no known artifact", async () => {
    await env.PREVIEW_BUCKET.put(MAIN_PREVIEW_KEY, "test archive contents", {
      customMetadata: { "commit-sha": COMMIT_SHA }
    });
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({ data: { total_count: 0, artifacts: [] } })
    );

    const res = await get("/previews/v1/main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { run_id: number | null } };
    expect(body.result.run_id).toBeNull();
  });

  it("serves the second request from CACHE_KV without re-reading R2 or GitHub", async () => {
    await env.PREVIEW_BUCKET.put(MAIN_PREVIEW_KEY, "v1", {
      customMetadata: { "commit-sha": "111" }
    });
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({ data: { total_count: 0, artifacts: [] } })
    );

    const first = await get("/previews/v1/main");
    expect(
      ((await first.json()) as { result: { commit_sha: string } }).result
        .commit_sha
    ).toBe("111");

    // Overwrite the R2 object directly - a cache hit should still serve the
    // first response's data rather than reflecting this change.
    await env.PREVIEW_BUCKET.put(MAIN_PREVIEW_KEY, "v2", {
      customMetadata: { "commit-sha": "222" }
    });
    const second = await get("/previews/v1/main");
    const secondBody = (await second.json()) as {
      result: { commit_sha: string };
    };
    expect(secondBody.result.commit_sha).toBe("111");
    expect(ghRequest).toHaveBeenCalledTimes(1);
  });
});

describe("Previews API v1 - GET /previews/v1/main/download", () => {
  beforeEach(async () => {
    restoreConsole = suppressConsole();
    await env.CACHE_KV.delete("preview:main");
    await env.PREVIEW_BUCKET.delete(MAIN_PREVIEW_KEY);
    vi.clearAllMocks();
    (vi.mocked(ghRequest) as MockGitHubRequest).mockImplementation(
      async () => ({ data: { total_count: 0, artifacts: [] } })
    );
  });

  afterEach(() => {
    restoreConsole?.();
    restoreConsole = null;
  });

  it("returns 404 when no main preview has been published", async () => {
    const res = await get("/previews/v1/main/download");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("redirects to the permanent main preview download URL", async () => {
    await env.PREVIEW_BUCKET.put(MAIN_PREVIEW_KEY, "test archive contents");

    const res = await get("/previews/v1/main/download");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://download.fossbilling.org/FOSSBilling-preview.zip"
    );
  });

  it("shares the metadata route's cache instead of re-reading R2", async () => {
    await env.PREVIEW_BUCKET.put(MAIN_PREVIEW_KEY, "test archive contents");
    const headSpy = vi.spyOn(env.PREVIEW_BUCKET, "head");

    await get("/previews/v1/main");
    const res = await get("/previews/v1/main/download");

    expect(res.status).toBe(302);
    // The R2 HEAD ran once (warming the cache on the first request) - the
    // download request reused it rather than reading R2 again.
    expect(headSpy).toHaveBeenCalledTimes(1);
    headSpy.mockRestore();
  });
});
