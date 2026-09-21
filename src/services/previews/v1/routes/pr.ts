import { createRoute } from "@hono/zod-openapi";
import {
  ArtifactPreviewResponseSchema,
  errorResponse,
  PrNumberParamSchema
} from "../schemas/previews";
import { resolvePullRequestHeadSha } from "../github/artifacts";
import { PreviewLookupResult, resolveArtifactPreview } from "../resolve";
import { cachedLookup, DEFAULT_CACHE_TTL_SECONDS } from "../cache";
import { cacheKeyForSha, ttlForArtifact } from "./commit";
import { respondWithDownloadRedirect, respondWithLookup } from "./respond";
import { PreviewsV1App } from "./app";

// Resolves a PR number to its artifact preview by first finding the head
// SHA, then delegating to the same commit-keyed cache entry /commit/{sha}
// reads - a client following a PR's download_url to its canonical
// /commit/{sha} form reuses the resolve instead of paying the GitHub chain
// again within the window. The stored entry carries pr_number: null (the
// commit route's shape); the PR number is overlaid here, after the shared
// read.
async function resolvePrPreview(
  githubToken: string,
  prNumber: number,
  kv: KVNamespace,
  waitUntil?: (promise: Promise<unknown>) => void
): Promise<PreviewLookupResult> {
  const head = await resolvePullRequestHeadSha(githubToken, prNumber);
  if (head.status !== "found") return head;

  const commit = await cachedLookup(
    kv,
    cacheKeyForSha(head.data),
    () => resolveArtifactPreview(githubToken, head.data, null),
    ttlForArtifact,
    waitUntil
  );
  if (commit.status !== "found") return commit;
  return {
    status: "found",
    data: { ...commit.data, pr_number: prNumber }
  };
}

const notFoundMessage = (prNumber: number) =>
  `No pull request #${prNumber} was found, or it has no preview build yet.`;

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
      () =>
        resolvePrPreview(githubToken, number, c.env.CACHE_KV, (p) =>
          c.executionCtx.waitUntil(p)
        ),
      DEFAULT_CACHE_TTL_SECONDS,
      (p) => c.executionCtx.waitUntil(p)
    );

    return respondWithLookup(c, result, notFoundMessage(number));
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

    // Shares the metadata route's cache entry - see the equivalent comment
    // in routes/commit.ts. Without this, every download hit would cost 3
    // GitHub API calls (PR->SHA, SHA->artifact, then the redirect) instead
    // of the 1 that's actually unavoidable.
    const artifact = await cachedLookup(
      c.env.CACHE_KV,
      `preview:pr:${number}`,
      () =>
        resolvePrPreview(githubToken, number, c.env.CACHE_KV, (p) =>
          c.executionCtx.waitUntil(p)
        ),
      DEFAULT_CACHE_TTL_SECONDS,
      (p) => c.executionCtx.waitUntil(p)
    );
    return respondWithDownloadRedirect(
      c,
      githubToken,
      artifact,
      notFoundMessage(number)
    );
  });
}
