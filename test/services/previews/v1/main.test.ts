import { describe, it, expect, beforeEach } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import app from "../../../../src/app";

const MAIN_PREVIEW_KEY = "FOSSBilling-preview.zip";

async function get(path: string) {
  const ctx = createExecutionContext();
  const res = await app.request(path, {}, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("Previews API v1 - GET /previews/v1/main", () => {
  beforeEach(async () => {
    await env.CACHE_KV.delete("preview:main");
    await env.PREVIEW_BUCKET.delete(MAIN_PREVIEW_KEY);
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
        "commit-sha": "abc1234567890abc1234567890abc1234567890"
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

    expect(body.result.commit_sha).toBe(
      "abc1234567890abc1234567890abc1234567890"
    );
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
      result: { commit_sha: string | null; digest: string | null };
    };
    expect(body.result.commit_sha).toBeNull();
    expect(body.result.digest).toBeNull();
  });

  it("serves the second request from CACHE_KV without re-reading R2", async () => {
    await env.PREVIEW_BUCKET.put(MAIN_PREVIEW_KEY, "v1", {
      customMetadata: { "commit-sha": "111" }
    });
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
  });
});
