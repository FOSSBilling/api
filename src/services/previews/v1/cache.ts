import { GithubLookupResult } from "./github/artifacts";

// Previews churn often (a new commit on a PR supersedes the last build
// within minutes), so a short TTL keeps CACHE_KV useful without serving
// meaningfully stale data - matches download-worker's existing choice for
// the same trade-off.
const CACHE_TTL_SECONDS = 60;

// Only "found" results are cached. "not_found"/"unavailable" always
// re-resolve, so a transient GitHub hiccup or a not-yet-built PR doesn't
// get stuck negative for the TTL window.
export async function cachedLookup<T>(
  kv: KVNamespace,
  key: string,
  resolve: () => Promise<GithubLookupResult<T>>
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
      expirationTtl: CACHE_TTL_SECONDS
    });
  }
  return result;
}
