import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { cachedLookup } from "../../../../src/services/previews/v1/cache";

// cachedLookup's positive-hit, corrupt-entry, and TTL behaviors are covered
// at the route level (main/pr/commit/budget suites assert the exact KV
// writes through real requests). This file keeps only the negative-sentinel
// behavior, which no route exercises directly.
describe("previews/v1 cachedLookup - negative caching", () => {
  beforeEach(async () => {
    await env.CACHE_KV.delete("test-key");
  });

  it("caches not_found results with a short TTL and serves them without re-resolving", async () => {
    const putSpy = vi.spyOn(env.CACHE_KV, "put");
    const resolve = vi.fn().mockResolvedValue({ status: "not_found" });

    const result = await cachedLookup(env.CACHE_KV, "test-key", resolve);
    expect(result.status).toBe("not_found");
    expect(putSpy).toHaveBeenCalledWith("test-key", "__not_found__", {
      expirationTtl: 60
    });

    putSpy.mockRestore();
    const second = await cachedLookup(env.CACHE_KV, "test-key", resolve);
    expect(second.status).toBe("not_found");
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
