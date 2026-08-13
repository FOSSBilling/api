import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { cachedLookup } from "../../../../src/services/previews/v1/cache";

describe("previews/v1 cachedLookup", () => {
  beforeEach(async () => {
    await env.CACHE_KV.delete("test-key");
  });

  it("defaults to a 60s TTL", async () => {
    const putSpy = vi.spyOn(env.CACHE_KV, "put");

    await cachedLookup(env.CACHE_KV, "test-key", async () => ({
      status: "found",
      data: "value"
    }));

    expect(putSpy).toHaveBeenCalledWith("test-key", JSON.stringify("value"), {
      expirationTtl: 60
    });
    putSpy.mockRestore();
  });

  it("accepts a longer TTL for immutable data", async () => {
    const putSpy = vi.spyOn(env.CACHE_KV, "put");

    await cachedLookup(
      env.CACHE_KV,
      "test-key",
      async () => ({ status: "found", data: "value" }),
      3600
    );

    expect(putSpy).toHaveBeenCalledWith("test-key", JSON.stringify("value"), {
      expirationTtl: 3600
    });
    putSpy.mockRestore();
  });

  it("does not cache not_found results", async () => {
    const putSpy = vi.spyOn(env.CACHE_KV, "put");

    const result = await cachedLookup(env.CACHE_KV, "test-key", async () => ({
      status: "not_found"
    }));

    expect(result.status).toBe("not_found");
    expect(putSpy).not.toHaveBeenCalled();
    putSpy.mockRestore();
  });

  it("serves a cache hit without calling resolve again", async () => {
    const resolve = vi.fn().mockResolvedValue({ status: "found", data: "v1" });

    await cachedLookup(env.CACHE_KV, "test-key", resolve);
    const second = await cachedLookup(env.CACHE_KV, "test-key", resolve);

    expect(second).toEqual({ status: "found", data: "v1" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
