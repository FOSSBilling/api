import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { cachedLookup } from "../../../../src/services/previews/v1/cache";

// cachedLookup's positive-hit, corrupt-entry, and TTL behaviors are covered
// at the route level (main/pr/commit/budget suites assert the exact KV
// writes through real requests). This file keeps the two behaviors no route
// pins directly: the negative-sentinel write-and-serve, and "unavailable"
// never being cached (the route-level 503 test checks only the response).
describe("previews/v1 cachedLookup - cache contracts", () => {
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

  it("does not cache unavailable results and re-resolves on the next call", async () => {
    const putSpy = vi.spyOn(env.CACHE_KV, "put");
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        status: "unavailable",
        error: { message: "boom", httpStatus: 500 } as never
      })
      .mockResolvedValueOnce({ status: "found", data: "recovered" });

    const result = await cachedLookup(env.CACHE_KV, "test-key", resolve);
    expect(result.status).toBe("unavailable");
    expect(putSpy).not.toHaveBeenCalled();

    // A transient hiccup must not pin the route into an error for a TTL
    // window: the next call re-resolves and can succeed.
    const second = await cachedLookup(env.CACHE_KV, "test-key", resolve);
    expect(second).toEqual({ status: "found", data: "recovered" });
    expect(resolve).toHaveBeenCalledTimes(2);
    putSpy.mockRestore();
  });
});
