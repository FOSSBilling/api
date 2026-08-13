import { createRoute } from "@hono/zod-openapi";
import {
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
      COMMIT_CACHE_TTL_SECONDS
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
      COMMIT_CACHE_TTL_SECONDS
    );
    return respondWithDownloadRedirect(
      c,
      githubToken,
      artifact,
      `No preview artifact exists for commit ${sha}.`
    );
  });
}
