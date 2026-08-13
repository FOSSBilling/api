import { createRoute } from "@hono/zod-openapi";
import { Context } from "hono";
import {
  MainPreview,
  MainPreviewResponseSchema,
  errorResponse
} from "../schemas/previews";
import { getMainPreviewObject } from "../r2";
import { notFoundBody } from "./errors";
import { PreviewsV1App } from "./app";

const MAIN_CACHE_KEY = "preview:main";
const MAIN_CACHE_TTL_SECONDS = 60;

// Shared by /main and /main/download - both need the same cache-then-R2
// lookup, just to different ends (the full body vs. only download_url).
async function resolveMainPreview(
  c: Context<{ Bindings: CloudflareBindings }>
): Promise<MainPreview | null> {
  const cached = await c.env.CACHE_KV.get(MAIN_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached) as MainPreview;
  }

  const object = await getMainPreviewObject(c.env.PREVIEW_BUCKET);
  if (!object) return null;

  const result: MainPreview = {
    commit_sha: object.commitSha,
    short_sha: object.commitSha?.slice(0, 7) ?? null,
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
