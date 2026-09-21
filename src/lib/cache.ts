import type { Context } from "hono";

export function normalizePublicCacheKey(url: string): string {
  const cacheUrl = new URL(url);
  cacheUrl.search = "";
  cacheUrl.hash = "";
  return cacheUrl.toString();
}

export function publicCacheKey(c: Context): string {
  return normalizePublicCacheKey(c.req.url);
}

// In-isolate coalescing of concurrent identical async lookups: N requests
// hitting a cold cache share one resolve instead of each repeating the
// upstream chain. Deliberately scoped to a single isolate's lifetime -
// KV is eventually consistent, so this collapses the common burst, not
// every stampede.
const inflight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(
  key: string,
  resolve: () => Promise<T>
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = resolve().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
