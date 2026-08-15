import { GithubLookupResult } from "./github/artifacts";

// Default for anything that moves (main, pr/{number}) - previews churn
// often (a new commit on a PR supersedes the last build within minutes),
// so a short TTL keeps CACHE_KV useful without serving meaningfully stale
// data - matches download-worker's existing choice for the same trade-off.
// Callers addressing something immutable (a fixed commit/artifact) pass a
// longer ttlSeconds explicitly - see routes/commit.ts and routes/respond.ts.
export const DEFAULT_CACHE_TTL_SECONDS = 60;

// Cloudflare KV's own floor - a shorter expirationTtl is a 400 at the API
// level, not just an app-level policy choice.
const KV_MIN_TTL_SECONDS = 60;

// Only "found" results are cached. "not_found"/"unavailable" always
// re-resolve, so a transient GitHub hiccup or a not-yet-built PR doesn't
// get stuck negative for the TTL window.
//
// ttlSeconds may be a function of the resolved data instead of a fixed
// number - see routes/commit.ts, which caps the cache lifetime at the
// artifact's own remaining GitHub retention so a lookup resolved just
// before expiry doesn't outlive it and keep serving a 200 after GitHub
// itself has started 404ing. If the computed TTL is under KV's 60s floor,
// the result is returned but not cached at all - better to re-resolve
// live for the rest of that final minute than to either violate the floor
// or round up and cache something past its real expiry.
export async function cachedLookup<T>(
  kv: KVNamespace,
  key: string,
  resolve: () => Promise<GithubLookupResult<T>>,
  ttlSeconds: number | ((data: T) => number) = DEFAULT_CACHE_TTL_SECONDS
): Promise<GithubLookupResult<T>> {
  const cached = await kv.get(key);
  if (cached !== null) {
    try {
      return { status: "found", data: JSON.parse(cached) as T };
    } catch {
      // Corrupt cache entry - fall through to a fresh resolve.
    }
  }

  const result = await resolve();
  if (result.status === "found") {
    const ttl =
      typeof ttlSeconds === "function" ? ttlSeconds(result.data) : ttlSeconds;
    if (ttl >= KV_MIN_TTL_SECONDS) {
      await kv.put(key, JSON.stringify(result.data), {
        expirationTtl: ttl
      });
    }
  }
  return result;
}
