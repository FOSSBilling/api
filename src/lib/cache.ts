import type { Context, MiddlewareHandler } from "hono";
import { cache } from "hono/cache";

function normalizePublicCacheKey(url: string): string {
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

// Only for public GET representations that never depend on credentials.
// Keep Hono's key/Vary and response privacy safeguards, but prevent an
// unused Authorization header from turning off backend-protective caching.
// Downstream handlers always see the original request (including credentials).
export function publicResponseCache(
  options: Parameters<typeof cache>[0]
): MiddlewareHandler {
  const middleware = cache(options);
  return async (c, next) => {
    const original = c.req.raw;
    if (c.req.method !== "GET" || !original.headers.has("Authorization")) {
      return middleware(c, next);
    }
    const headers = new Headers(original.headers);
    headers.delete("Authorization");
    c.req.raw = new Request(original, { headers });
    try {
      return await middleware(c, async () => {
        c.req.raw = original;
        await next();
      });
    } finally {
      c.req.raw = original;
    }
  };
}
