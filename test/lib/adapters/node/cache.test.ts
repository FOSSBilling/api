import { describe, it, expect, beforeEach } from "vitest";
import {
  SQLiteCacheAdapter,
  createMemoryCache
} from "../../../../src/lib/adapters/node/cache";

describe("SQLiteCacheAdapter - Memory", () => {
  let cache: SQLiteCacheAdapter;

  beforeEach(() => {
    cache = createMemoryCache();
  });

  it("should store and retrieve values", async () => {
    await cache.put("key1", "value1");
    const result = await cache.get("key1");
    expect(result).toBe("value1");
  });

  it("should return null for non-existent keys", async () => {
    const result = await cache.get("nonexistent");
    expect(result).toBeNull();
  });

  it("should overwrite existing values", async () => {
    await cache.put("key1", "value1");
    await cache.put("key1", "value2");
    const result = await cache.get("key1");
    expect(result).toBe("value2");
  });

  it("should delete values", async () => {
    await cache.put("key1", "value1");
    await cache.delete("key1");
    const result = await cache.get("key1");
    expect(result).toBeNull();
  });

  it("should handle expirationTtl", async () => {
    await cache.put("key1", "value1", { expirationTtl: 1 });
    expect(await cache.get("key1")).toBe("value1");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await cache.get("key1")).toBeNull();
  });

  it("should handle expiration timestamp", async () => {
    const future = Math.floor((Date.now() + 2000) / 1000);
    await cache.put("key1", "value1", { expiration: future });
    expect(await cache.get("key1")).toBe("value1");
  });

  it("should clear all entries", async () => {
    await cache.put("key1", "value1");
    await cache.put("key2", "value2");
    cache.clearAll();
    expect(await cache.get("key1")).toBeNull();
    expect(await cache.get("key2")).toBeNull();
  });

  it("should clear expired entries only", async () => {
    await cache.put("key1", "value1", { expirationTtl: 1 });
    await cache.put("key2", "value2");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    cache.clearExpired();
    expect(await cache.get("key1")).toBeNull();
    expect(await cache.get("key2")).toBe("value2");
  });

  it("should handle null expire_at correctly", async () => {
    await cache.put("key1", "value1");
    cache.clearExpired();
    expect(await cache.get("key1")).toBe("value1");
  });
});
