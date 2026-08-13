import { createRoute } from "@hono/zod-openapi";
import { MainPreviewResponseSchema, errorResponse } from "../schemas/previews";
import { getMainPreviewObject } from "../r2";
import { PreviewsV1App } from "./app";

const MAIN_CACHE_KEY = "preview:main";
const MAIN_CACHE_TTL_SECONDS = 60;

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
    const cached = await c.env.CACHE_KV.get(MAIN_CACHE_KEY);
    if (cached) {
      return c.json({ result: JSON.parse(cached) }, 200);
    }

    const object = await getMainPreviewObject(c.env.PREVIEW_BUCKET);
    if (!object) {
      return c.json(
        {
          error: {
            message: "No main preview has been published yet",
            code: "NOT_FOUND"
          }
        },
        404
      );
    }

    const result = {
      commit_sha: object.commitSha,
      short_sha: object.commitSha?.slice(0, 7) ?? null,
      digest: object.digest,
      size_bytes: object.sizeBytes,
      last_modified: object.lastModified,
      download_url: object.downloadUrl,
      source: "r2" as const
    };

    await c.env.CACHE_KV.put(MAIN_CACHE_KEY, JSON.stringify(result), {
      expirationTtl: MAIN_CACHE_TTL_SECONDS
    });

    return c.json({ result }, 200);
  });
}
