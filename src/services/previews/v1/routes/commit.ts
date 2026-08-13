import { createRoute } from "@hono/zod-openapi";
import {
  ArtifactPreviewResponseSchema,
  CommitShaParamSchema,
  errorResponse
} from "../schemas/previews";
import { getArtifactDownloadUrl } from "../github/artifacts";
import { resolveArtifactPreview } from "../resolve";
import { cachedLookup } from "../cache";
import { githubErrorBody, notFoundBody, statusFromGithubError } from "./errors";
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

    if (result.status === "found") {
      return c.json({ result: result.data }, 200);
    }
    if (result.status === "not_found") {
      return c.json(
        notFoundBody(`No preview artifact exists for commit ${sha}.`),
        404
      );
    }
    return c.json(
      githubErrorBody(result.error, "Failed to look up the preview artifact"),
      statusFromGithubError(result.error)
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
    if (artifact.status === "not_found") {
      return c.json(
        notFoundBody(`No preview artifact exists for commit ${sha}.`),
        404
      );
    }
    if (artifact.status === "unavailable") {
      return c.json(
        githubErrorBody(
          artifact.error,
          "Failed to look up the preview artifact"
        ),
        statusFromGithubError(artifact.error)
      );
    }

    const redirect = await getArtifactDownloadUrl(
      githubToken,
      artifact.data.artifact_id
    );
    if (redirect.status === "not_found") {
      return c.json(notFoundBody("The preview artifact has expired."), 404);
    }
    if (redirect.status === "unavailable") {
      return c.json(
        githubErrorBody(
          redirect.error,
          "Failed to resolve the artifact download URL"
        ),
        statusFromGithubError(redirect.error)
      );
    }

    return c.redirect(redirect.data, 302);
  });
}
