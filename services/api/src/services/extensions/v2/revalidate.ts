import { Context } from "hono";
import { getPlatform } from "../../../lib/middleware";
import { invalidateListCache } from "../v1/list-cache";

// The extensions site route-caches its public extension pages behind
// Cloudflare-CDN-Cache-Control (maxAge + stale-while-revalidate). Those
// windows are the correctness floor for freshness; this purge is the latency
// optimization that makes api-side mutations visible within a second or two
// instead of after a cache window.
//
// Extension-mutating endpoints must call revalidateExtensions(c) after a
// successful write (see AGENTS.md). The call is fire-and-forget: failures
// are logged and swallowed, because the mutation has already succeeded and
// the cache windows bound any resulting staleness.
//
// The v1 list body cache (../v1/list-cache) hangs off the same extension directory, so
// it is invalidated here too - same fire-and-forget trade: a failed delete
// merely leaves the list stale until its own short TTL expires.
const REVALIDATE_TAGS = ["extensions", "developers"];
const REVALIDATE_URL = "https://extensions.fossbilling.org/api/revalidate";

export function revalidateExtensions(c: Context): void {
  const platform = getPlatform(c);
  invalidateListCache(platform.getCache("CACHE_KV"), platform.waitUntil);

  const secret = platform.getEnv("EXTENSIONS_REVALIDATE_SECRET");
  if (!secret) {
    // Unconfigured (e.g. local dev without the secret): skipping is safe —
    // the site's cache windows bound staleness regardless.
    return;
  }

  const purge = platform
    .fetchService(
      "EXTENSIONS_FRONTEND",
      new Request(REVALIDATE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ tags: REVALIDATE_TAGS })
      })
    )
    .then(async (response) => {
      if (!response.ok) {
        console.error(
          `[revalidate] purge returned ${response.status}; staleness is bounded by the site's cache windows`
        );
      }
    })
    .catch((error) => {
      console.error("[revalidate] purge request failed:", error);
    });

  platform.waitUntil(purge);
}
