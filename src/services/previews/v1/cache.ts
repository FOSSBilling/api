import { GithubLookupResult } from "./github/artifacts";

// Default for anything that moves (main, pr/{number}) - previews churn
// often (a new commit on a PR supersedes the last build within minutes),
// so a short TTL keeps CACHE_KV useful without serving meaningfully stale
// data - matches download-worker's existing choice for the same trade-off.
// Callers addressing something immutable (a fixed commit/artifact) pass a
// longer ttlSeconds explicitly - see routes/commit.ts and routes/respond.ts.
export const DEFAULT_CACHE_TTL_SECONDS = 60;

// Only "found" results are cached. "not_found"/"unavailable" always
// re-resolve, so a transient GitHub hiccup or a not-yet-built PR doesn't
// get stuck negative for the TTL window.
export async function cachedLookup<T>(
  kv: KVNamespace,
  key: string,
  resolve: () => Promise<GithubLookupResult<T>>,
  ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS
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
    await kv.put(key, JSON.stringify(result.data), {
      expirationTtl: ttlSeconds
    });
  }
  return result;
}
