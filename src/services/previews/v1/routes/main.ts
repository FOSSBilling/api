import { createRoute } from "@hono/zod-openapi";
import { Context } from "hono";
import {
  MainPreview,
  MainPreviewResponseSchema,
  errorResponse
} from "../schemas/previews";
import { getMainPreviewObject } from "../r2";
import { findPreviewArtifactByCommitSha } from "../github/artifacts";
import { notFoundBody } from "./errors";
import { PreviewsV1App } from "./app";

const MAIN_CACHE_KEY = "preview:main";
const MAIN_CACHE_TTL_SECONDS = 60;

// Enrichment only - run_id/artifact_id/created_at/expires_at come from
// that commit's GitHub Actions artifact when resolvable. A miss for any
// reason (no commit_sha yet, artifact expired, GitHub unavailable) just
// leaves them null; it never fails or degrades the response, since
// download_url/digest below are R2-sourced and don't depend on this.
async function resolveArtifactFields(
  githubToken: string,
  commitSha: string | null
): Promise<
  Pick<MainPreview, "run_id" | "artifact_id" | "created_at" | "expires_at">
> {
  const empty = {
    run_id: null,
    artifact_id: null,
    created_at: null,
    expires_at: null
  };
  if (!commitSha) return empty;

  const artifact = await findPreviewArtifactByCommitSha(githubToken, commitSha);
  if (artifact.status !== "found") return empty;

  return {
    run_id: artifact.data.runId,
    artifact_id: artifact.data.artifactId,
    created_at: artifact.data.createdAt,
    expires_at: artifact.data.expiresAt
  };
}

// Shared by /main and /main/download - both need the same cache-then-R2
// lookup, just to different ends (the full body vs. only download_url).
async function resolveMainPreview(
  c: Context<{ Bindings: CloudflareBindings }>
): Promise<MainPreview | null> {
  const cached = await c.env.CACHE_KV.get(MAIN_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as MainPreview;
    } catch {
      // Corrupt cache entry - fall through to a fresh R2 lookup, matching
      // cachedLookup()'s handling of the same situation.
    }
  }

  const object = await getMainPreviewObject(c.env.PREVIEW_BUCKET);
  if (!object) return null;

  const artifactFields = await resolveArtifactFields(
    c.env.GITHUB_TOKEN,
    object.commitSha
  );

  const result: MainPreview = {
    commit_sha: object.commitSha,
    short_sha: object.commitSha?.slice(0, 7) ?? null,
    pr_number: null,
    ...artifactFields,
    digest: object.digest,
    size_bytes: object.sizeBytes,
    last_modified: object.lastModified,
    download_url: object.downloadUrl,
    source: "r2"
  };

  await c.env.CACHE_KV.put(MAIN_CACHE_KEY, JSON.stringify(result), {
    expirationTtl: MAIN_CACHE_TTL_SECONDS
  });

  return result;
}

export function registerMainRoutes(app: PreviewsV1App): void {
  const mainRoute = createRoute({
    method: "get",
    path: "/main",
    tags: ["Previews"],
    summary: "Current main preview",
    responses: {
      200: {
        content: {
          "application/json": { schema: MainPreviewResponseSchema }
        },
        description: "The current main preview build"
      },
      404: errorResponse("No main preview has been published yet"),
      500: errorResponse("R2 lookup failed")
    }
  });

  app.openapi(mainRoute, async (c) => {
    const result = await resolveMainPreview(c);
    if (!result) {
      return c.json(
        notFoundBody("No main preview has been published yet"),
        404
      );
    }
    return c.json({ result }, 200);
  });

  // Unlike /pr/{number}/download and /commit/{sha}/download, main's
  // download_url is a fixed, permanent path (download.fossbilling.org)
  // rather than a live, short-lived signed URL - so this is a plain
  // redirect once existence is confirmed, not a fresh resolution on every
  // hit. Exists for uniform addressing: every resource under /previews/v1
  // has a /download sub-route, so callers never need to special-case main
  // to reach a download link instead of reading it out of the JSON body.
  const mainDownloadRoute = createRoute({
    method: "get",
    path: "/main/download",
    tags: ["Previews"],
    summary: "Download the current main preview",
    responses: {
      302: { description: "Redirect to the main preview download URL" },
      404: errorResponse("No main preview has been published yet"),
      500: errorResponse("R2 lookup failed")
    }
  });

  app.openapi(mainDownloadRoute, async (c) => {
    const result = await resolveMainPreview(c);
    if (!result) {
      return c.json(
        notFoundBody("No main preview has been published yet"),
        404
      );
    }
    return c.redirect(result.download_url, 302);
  });
}
