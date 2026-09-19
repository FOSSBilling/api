import { Context } from "hono";
import { getPlatform } from "../../../lib/middleware";

// The extensions site route-caches its public catalogue pages behind
// Cloudflare-CDN-Cache-Control (maxAge + stale-while-revalidate). Those
// windows are the correctness floor for freshness; this purge is the latency
// optimization that makes api-side mutations visible within a second or two
// instead of after a cache window.
//
// Catalogue-mutating endpoints must call revalidateCatalogue(c) after a
// successful write (see AGENTS.md). The call is fire-and-forget: failures
// are logged and swallowed, because the mutation has already succeeded and
// the cache windows bound any resulting staleness.
const REVALIDATE_TAGS = ["catalogue", "developers"];
const REVALIDATE_URL = "https://extensions.fossbilling.org/api/revalidate";

export function revalidateCatalogue(
  c: Context<{ Bindings: CloudflareBindings }>
): void {
  const secret = getPlatform(c).getEnv("EXTENSIONS_REVALIDATE_SECRET");
  if (!secret) {
    // Unconfigured (e.g. local dev without the secret): skipping is safe —
    // the site's cache windows bound staleness regardless.
    return;
  }

  const purge = c.env.EXTENSIONS_FRONTEND.fetch(REVALIDATE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ tags: REVALIDATE_TAGS })
  })
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

  c.executionCtx.waitUntil(purge);
}
