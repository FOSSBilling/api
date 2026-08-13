import { createRoute } from "@hono/zod-openapi";
import {
  ArtifactPreviewResponseSchema,
  errorResponse,
  PrNumberParamSchema
} from "../schemas/previews";
import {
  getArtifactDownloadUrl,
  resolvePullRequestHeadSha
} from "../github/artifacts";
import { PreviewLookupResult, resolveArtifactPreview } from "../resolve";
import { cachedLookup } from "../cache";
import { githubErrorBody, notFoundBody, statusFromGithubError } from "./errors";
import { PreviewsV1App } from "./app";

// Resolves a PR number to its artifact preview by first finding the head
// SHA, then delegating to the same commit-based resolver /commit/{sha}
// uses - one GitHub-facing code path handles both routes.
async function resolvePrPreview(
  githubToken: string,
  prNumber: number
): Promise<PreviewLookupResult> {
  const head = await resolvePullRequestHeadSha(githubToken, prNumber);
  if (head.status !== "found") return head;
  return resolveArtifactPreview(githubToken, head.data, prNumber);
}

export function registerPrRoutes(app: PreviewsV1App): void {
  const prRoute = createRoute({
    method: "get",
    path: "/pr/{number}",
    tags: ["Previews"],
    summary: "Current preview build for a pull request",
    request: { params: PrNumberParamSchema },
    responses: {
      200: {
        content: {
          "application/json": { schema: ArtifactPreviewResponseSchema }
        },
        description: "The current preview build for that pull request"
      },
      404: errorResponse("No such pull request, or it has no preview build"),
      422: errorResponse("number param failed validation"),
      429: errorResponse("GitHub API rate limit exceeded"),
      500: errorResponse("Unexpected error"),
      503: errorResponse("GitHub is temporarily unavailable")
    }
  });

  app.openapi(prRoute, async (c) => {
    const { number } = c.req.valid("param");
    const githubToken = c.env.GITHUB_TOKEN;

    const result = await cachedLookup(
      c.env.CACHE_KV,
      `preview:pr:${number}`,
      () => resolvePrPreview(githubToken, number)
    );

    if (result.status === "found") {
      return c.json({ result: result.data }, 200);
    }
    if (result.status === "not_found") {
      return c.json(
        notFoundBody(
          `No pull request #${number} was found, or it has no preview build yet.`
        ),
        404
      );
    }
    return c.json(
      githubErrorBody(result.error, "Failed to look up the preview artifact"),
      statusFromGithubError(result.error)
    );
  });

  const prDownloadRoute = createRoute({
    method: "get",
    path: "/pr/{number}/download",
    tags: ["Previews"],
    summary: "Download the current preview build for a pull request",
    request: { params: PrNumberParamSchema },
    responses: {
      302: { description: "Redirect to GitHub's live artifact download URL" },
      404: errorResponse("No such pull request, or it has no preview build"),
      422: errorResponse("number param failed validation"),
      429: errorResponse("GitHub API rate limit exceeded"),
      500: errorResponse("Unexpected error"),
      503: errorResponse("GitHub is temporarily unavailable")
    }
  });

  app.openapi(prDownloadRoute, async (c) => {
    const { number } = c.req.valid("param");
    const githubToken = c.env.GITHUB_TOKEN;

    // Always resolved live, same reasoning as /commit/{sha}/download.
    const artifact = await resolvePrPreview(githubToken, number);
    if (artifact.status === "not_found") {
      return c.json(
        notFoundBody(
          `No pull request #${number} was found, or it has no preview build yet.`
        ),
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
