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

  it("does not cache unavailable results", async () => {
    const putSpy = vi.spyOn(env.CACHE_KV, "put");

    const result = await cachedLookup(env.CACHE_KV, "test-key", async () => ({
      status: "unavailable",
      error: { message: "boom", httpStatus: 500 } as never
    }));

    expect(result.status).toBe("unavailable");
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

  it("falls back to a fresh resolve on a corrupt cache entry", async () => {
    await env.CACHE_KV.put("test-key", "not valid json{");
    const resolve = vi.fn().mockResolvedValue({ status: "found", data: "v1" });

    const result = await cachedLookup(env.CACHE_KV, "test-key", resolve);

    expect(result).toEqual({ status: "found", data: "v1" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("computes the TTL from the resolved data when given a function", async () => {
    const putSpy = vi.spyOn(env.CACHE_KV, "put");
    const ttlFor = vi.fn((data: { value: string }) =>
      data.value === "value" ? 120 : 60
    );

    await cachedLookup(
      env.CACHE_KV,
      "test-key",
      async () => ({ status: "found", data: { value: "value" } }),
      ttlFor
    );

    expect(ttlFor).toHaveBeenCalledWith({ value: "value" });
    expect(putSpy).toHaveBeenCalledWith(
      "test-key",
      JSON.stringify({ value: "value" }),
      { expirationTtl: 120 }
    );
    putSpy.mockRestore();
  });

  it("skips caching entirely when the computed TTL is under KV's 60s floor", async () => {
    const putSpy = vi.spyOn(env.CACHE_KV, "put");

    const result = await cachedLookup(
      env.CACHE_KV,
      "test-key",
      async () => ({ status: "found", data: "value" }),
      () => 30
    );

    expect(result).toEqual({ status: "found", data: "value" });
    expect(putSpy).not.toHaveBeenCalled();
    putSpy.mockRestore();
  });
});
