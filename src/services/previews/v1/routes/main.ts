import { PreviewGitHub, previewGitHub } from "../github/request";
import { createRoute } from "@hono/zod-openapi";
import { Context } from "hono";
import {
  MainPreview,
  MainPreviewResponseSchema,
  errorResponse
} from "../schemas/previews";
import { getMainPreviewObject, MainPreviewObject } from "../r2";
import { findPreviewArtifactByCommitSha } from "../github/artifacts";
import { singleFlight } from "../../../../lib/cache";
import { cachedLookup, readCachedValue } from "../cache";
import { notFoundBody } from "./errors";
import { PreviewsV1App } from "./app";

// One shared cache entry for both routes: /main stores the enriched body,
// and /main/download stores the same shape with enrichment left null (the
// fields are optional and enrichment is best-effort by contract). Two
// differently-shaped or independently-negative entries could disagree -
// one route 404ing or serving a stale URL while the other resolves fine -
// which a single shared entry rules out by construction. cachedLookup()'s
// shared negative sentinel and TTL apply (see cache.ts).
const MAIN_CACHE_KEY = "preview:main";
const MAIN_CACHE_TTL_SECONDS = 60;

// Enrichment only - run_id/artifact_id/created_at/expires_at come from
// that commit's GitHub Actions artifact when resolvable. A miss for any
// reason (no commit_sha yet, artifact expired, GitHub unavailable) just
// leaves them null; it never fails or degrades the response, since
// download_url/digest below are R2-sourced and don't depend on this.
async function resolveArtifactFields(
  github: PreviewGitHub,
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

  const artifact = await findPreviewArtifactByCommitSha(github, commitSha);
  if (artifact.status !== "found") return empty;

  return {
    run_id: artifact.data.runId,
    artifact_id: artifact.data.artifactId,
    created_at: artifact.data.createdAt,
    expires_at: artifact.data.expiresAt
  };
}

// Shared R2 head for both routes: on a cold cache, a concurrent /main and
// /main/download resolve one object, not two.
function resolveMainObject(c: Context<{ Bindings: CloudflareBindings }>) {
  return singleFlight("previews:main:r2", () =>
    getMainPreviewObject(c.env.DOWNLOAD_BUCKET)
  );
}

// Both routes share this one entry: /main stores the enriched body, and
// /main/download stores the same shape with enrichment left null (the
// fields are optional and enrichment is best-effort by contract). Two
// differently-shaped or independently-negative entries could disagree -
// one route 404ing or serving a stale URL while the other resolves fine -
// which a single shared entry rules out by construction.
function buildMainPreview(
  object: MainPreviewObject,
  artifactFields: Pick<
    MainPreview,
    "run_id" | "artifact_id" | "created_at" | "expires_at"
  >
): MainPreview {
  return {
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
}

// Shared by /main - the full body, GitHub-enrichment included.
async function resolveMainPreview(
  c: Context<{ Bindings: CloudflareBindings }>
): Promise<MainPreview | null> {
  const result = await cachedLookup<MainPreview>(
    c.env.CACHE_KV,
    MAIN_CACHE_KEY,
    async () => {
      const object = await resolveMainObject(c);
      if (!object) {
        return { status: "not_found" as const };
      }
      const artifactFields = await (object.commitSha
        ? // Enrichment is keyed by commit: concurrent cold requests share one
          // GitHub lookup (charged once to the shared budget) without mixing
          // SHAs, and the R2 head above is already single-flighted so racing
          // requests observe the same object.
          singleFlight(`previews:main:enrich:${object.commitSha}`, () =>
            resolveArtifactFields(previewGitHub(c), object.commitSha)
          )
        : resolveArtifactFields(previewGitHub(c), null));
      return {
        status: "found" as const,
        data: buildMainPreview(object, artifactFields)
      };
    },
    MAIN_CACHE_TTL_SECONDS,
    (p) => c.executionCtx.waitUntil(p)
  );
  return result.status === "found" ? result.data : null;
}

// Shared by /main/download - the fixed download URL, no GitHub enrichment.
async function resolveMainDownloadUrl(
  c: Context<{ Bindings: CloudflareBindings }>
): Promise<string | null> {
  const read = await readCachedValue<MainPreview>(
    c.env.CACHE_KV,
    MAIN_CACHE_KEY
  );
  if (read === null) return null; // authoritative negative
  if (read !== "miss" && read.download_url) return read.download_url;

  // No write of any kind here, by design: /main owns the shared entry, and
  // an unenriched (or negative) body written from this route would silently
  // clobber a concurrently-cached enriched one. The cost of not warming
  // from the download path is one single-flighted R2 head per cold download
  // request - rare next to the embed traffic that hits /main and populates
  // the entry.
  const object = await resolveMainObject(c);
  return object?.downloadUrl ?? null;
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
    const downloadUrl = await resolveMainDownloadUrl(c);
    if (!downloadUrl) {
      return c.json(
        notFoundBody("No main preview has been published yet"),
        404
      );
    }
    return c.redirect(downloadUrl, 302);
  });
}
