import { createRoute } from "@hono/zod-openapi";
import {
  ArtifactPreview,
  ArtifactPreviewResponseSchema,
  CommitShaParamSchema,
  errorResponse
} from "../schemas/previews";
import { resolveArtifactPreview } from "../resolve";
import { cachedLookup } from "../cache";
import { respondWithDownloadRedirect, respondWithLookup } from "./respond";
import { PreviewsV1App } from "./app";

// A commit's build never changes once it exists, unlike main/pr's moving
// pointers - safe to cache far longer than the 60s default, well within
// GitHub's 14-day artifact retention. Cuts repeat-download GitHub calls by
// 60x for the same commit within an hour.
const COMMIT_CACHE_TTL_SECONDS = 3600;

const cacheKeyForSha = (sha: string) => `preview:commit:${sha.toLowerCase()}`;

// Subtracted from the computed TTL so the value we write already accounts
// for the round-trip between computing it here and cache.ts's kv.put()
// actually landing - without this, a lookup resolved with e.g. exactly
// 60s of real retention left could still get written with a TTL that
// technically outlives the artifact by however long that write took.
const WRITE_SAFETY_MARGIN_SECONDS = 5;

// Caps the cache lifetime at the artifact's own remaining GitHub retention
// - a lookup resolved shortly before an artifact expires must not be
// cached for the full 3600s, or /commit/{sha} would keep serving a 200
// with stale metadata for up to an hour after GitHub itself starts
// 404ing (which respondWithDownloadRedirect's live resolution already
// would). Within the final ~65s of an artifact's life this comes out
// under cache.ts's 60s KV floor, so that request (and any others until
// the artifact naturally falls out of GitHub's own list) is served live
// instead of cached - a short burst of extra GitHub calls right at the
// end of an artifact's life, never stale data.
function ttlForArtifact(artifact: ArtifactPreview): number {
  const remainingSeconds = Math.floor(
    (new Date(artifact.expires_at).getTime() - Date.now()) / 1000
  );
  // expires_at was empty/unparseable (toPreviewArtifact falls back to ""
  // when GitHub's own value is null) - no real signal to cap against, so
  // don't let a NaN here silently defeat caching on every request forever.
  if (Number.isNaN(remainingSeconds)) {
    return COMMIT_CACHE_TTL_SECONDS;
  }
  return Math.min(
    COMMIT_CACHE_TTL_SECONDS,
    remainingSeconds - WRITE_SAFETY_MARGIN_SECONDS
  );
}

export function registerCommitRoutes(app: PreviewsV1App): void {
  const commitRoute = createRoute({
    method: "get",
    path: "/commit/{sha}",
    tags: ["Previews"],
    summary: "Preview build for a specific commit",
    request: { params: CommitShaParamSchema },
    responses: {
      200: {
        content: {
          "application/json": { schema: ArtifactPreviewResponseSchema }
        },
        description: "The preview build for that commit"
      },
      404: errorResponse("No preview artifact exists for that commit"),
      422: errorResponse("sha param failed validation"),
      429: errorResponse("GitHub API rate limit exceeded"),
      500: errorResponse("Unexpected error"),
      503: errorResponse("GitHub is temporarily unavailable")
    }
  });

  app.openapi(commitRoute, async (c) => {
    const { sha } = c.req.valid("param");
    const githubToken = c.env.GITHUB_TOKEN;

    const result = await cachedLookup(
      c.env.CACHE_KV,
      cacheKeyForSha(sha),
      () => resolveArtifactPreview(githubToken, sha, null),
      ttlForArtifact
    );

    return respondWithLookup(
      c,
      result,
      `No preview artifact exists for commit ${sha}.`
    );
  });

  const commitDownloadRoute = createRoute({
    method: "get",
    path: "/commit/{sha}/download",
    tags: ["Previews"],
    summary: "Download the preview build for a specific commit",
    request: { params: CommitShaParamSchema },
    responses: {
      302: { description: "Redirect to GitHub's live artifact download URL" },
      404: errorResponse("No preview artifact exists for that commit"),
      422: errorResponse("sha param failed validation"),
      429: errorResponse("GitHub API rate limit exceeded"),
      500: errorResponse("Unexpected error"),
      503: errorResponse("GitHub is temporarily unavailable")
    }
  });

  app.openapi(commitDownloadRoute, async (c) => {
    const { sha } = c.req.valid("param");
    const githubToken = c.env.GITHUB_TOKEN;

    // Shares the metadata route's cache entry for which artifact to
    // download - only the signed URL itself (resolved inside
    // respondWithDownloadRedirect, on its own short-lived cache) has to be
    // re-checked often, since that's the part that actually expires.
    const artifact = await cachedLookup(
      c.env.CACHE_KV,
      cacheKeyForSha(sha),
      () => resolveArtifactPreview(githubToken, sha, null),
      ttlForArtifact
    );
    return respondWithDownloadRedirect(
      c,
      githubToken,
      artifact,
      `No preview artifact exists for commit ${sha}.`
    );
  });
}
