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
      `preview:commit:${sha.toLowerCase()}`,
      () => resolveArtifactPreview(githubToken, sha, null)
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

    // Always resolved live - GitHub's artifact download URL is a signed
    // link that expires in about a minute, so it can never be served from
    // CACHE_KV alongside the longer-lived metadata response.
    const artifact = await resolveArtifactPreview(githubToken, sha, null);
    return respondWithDownloadRedirect(
      c,
      githubToken,
      artifact,
      `No preview artifact exists for commit ${sha}.`
    );
  });
}
