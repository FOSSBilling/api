import { createRoute } from "@hono/zod-openapi";
import { Context } from "hono";
import {
  MainPreview,
  MainPreviewResponseSchema,
  errorResponse
} from "../schemas/previews";
import { getMainPreviewObject } from "../r2";
import { findPreviewArtifactByCommitSha } from "../github/artifacts";
import { singleFlight } from "../../../../lib/cache";
import { notFoundBody } from "./errors";
import { PreviewsV1App } from "./app";

const MAIN_CACHE_KEY = "preview:main";
const MAIN_CACHE_TTL_SECONDS = 60;
// /main/download's own entry, separate from MAIN_CACHE_KEY: /main's cached
// body carries GitHub-enriched artifact fields that /main/download neither
// needs nor wants to pay for on a cold cache. The download path does fall
// back to reading MAIN_CACHE_KEY when present - /main usually ran first
// and already paid for it.
const MAIN_URL_CACHE_KEY = "preview:main:url";
// Both routes 404 while no main preview has been published - cache that
// state briefly so the 404 path costs a KV read instead of an R2 head per
// request. An R2 miss is a stable signal (the object only exists once CI
// uploads it), so a 60s window is safe.
const MAIN_NEGATIVE_CACHE_TTL_SECONDS = 60;
const MAIN_NEGATIVE_CACHE_VALUE = "__main_preview_missing__";

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

// Shared R2 head for both routes: on a cold cache, a concurrent /main and
// /main/download resolve one object, not two.
function resolveMainObject(c: Context<{ Bindings: CloudflareBindings }>) {
  return singleFlight("previews:main:r2", () =>
    getMainPreviewObject(c.env.DOWNLOAD_BUCKET)
  );
}

// Shared by /main - the full body, GitHub-enrichment included.
async function resolveMainPreview(
  c: Context<{ Bindings: CloudflareBindings }>
): Promise<MainPreview | null> {
  const waitUntil = (p: Promise<unknown>) => c.executionCtx.waitUntil(p);

  const cached = await c.env.CACHE_KV.get(MAIN_CACHE_KEY);
  if (cached === MAIN_NEGATIVE_CACHE_VALUE) {
    return null;
  }
  if (cached) {
    try {
      return JSON.parse(cached) as MainPreview;
    } catch {
      // Corrupt cache entry - fall through to a fresh R2 lookup, matching
      // cachedLookup()'s handling of the same situation.
    }
  }

  const object = await resolveMainObject(c);
  if (!object) {
    waitUntil(
      c.env.CACHE_KV.put(MAIN_CACHE_KEY, MAIN_NEGATIVE_CACHE_VALUE, {
        expirationTtl: MAIN_NEGATIVE_CACHE_TTL_SECONDS
      })
    );
    return null;
  }

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

  waitUntil(
    c.env.CACHE_KV.put(MAIN_CACHE_KEY, JSON.stringify(result), {
      expirationTtl: MAIN_CACHE_TTL_SECONDS
    })
  );

  return result;
}

// Shared by /main/download - existence plus the fixed download URL only,
// with no GitHub enrichment. Checks MAIN_URL_CACHE_KEY first, then the
// full metadata entry (see MAIN_URL_CACHE_KEY above), then R2.
async function resolveMainDownloadUrl(
  c: Context<{ Bindings: CloudflareBindings }>
): Promise<string | null> {
  const waitUntil = (p: Promise<unknown>) => c.executionCtx.waitUntil(p);

  const urlCache = await c.env.CACHE_KV.get(MAIN_URL_CACHE_KEY);
  if (urlCache === MAIN_NEGATIVE_CACHE_VALUE) {
    return null;
  }
  if (urlCache) {
    try {
      return JSON.parse(urlCache) as string;
    } catch {
      // Corrupt cache entry - fall through.
    }
  }

  const fullCache = await c.env.CACHE_KV.get(MAIN_CACHE_KEY);
  if (fullCache === MAIN_NEGATIVE_CACHE_VALUE) {
    return null;
  }
  if (fullCache) {
    try {
      const parsed = JSON.parse(fullCache) as MainPreview;
      if (parsed.download_url) return parsed.download_url;
    } catch {
      // Corrupt cache entry - fall through to a fresh R2 lookup.
    }
  }

  const object = await resolveMainObject(c);
  if (!object) {
    waitUntil(
      c.env.CACHE_KV.put(MAIN_URL_CACHE_KEY, MAIN_NEGATIVE_CACHE_VALUE, {
        expirationTtl: MAIN_NEGATIVE_CACHE_TTL_SECONDS
      })
    );
    return null;
  }

  waitUntil(
    c.env.CACHE_KV.put(MAIN_URL_CACHE_KEY, JSON.stringify(object.downloadUrl), {
      expirationTtl: MAIN_CACHE_TTL_SECONDS
    })
  );
  return object.downloadUrl;
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
