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
