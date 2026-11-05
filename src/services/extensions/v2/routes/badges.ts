import { createRoute, z } from "@hono/zod-openapi";
import { makeBadge } from "badge-maker";
import { getExtensionsDb } from "../../../../lib/db";
import { ExtensionBadgesDatabase } from "../db/badges";
import { BadgeParamsSchema, BadgeQuerySchema } from "../schemas/badges";
import { errorResponse } from "../schemas/common";
import { ExtensionsV2App } from "./app";
import { errorBody, statusFromContentReadError } from "./errors";

export function registerBadgeRoutes(app: ExtensionsV2App): void {
  const route = createRoute({
    method: "get",
    path: "/extensions/{id}/badges/{type}",
    tags: ["Extensions"],
    summary: "Get a public extension badge",
    request: { params: BadgeParamsSchema, query: BadgeQuerySchema },
    responses: {
      200: {
        description:
          "SVG badge for the latest release's version or full FOSSBilling requirement, or the package license",
        content: { "image/svg+xml": { schema: z.string() } }
      },
      404: errorResponse("No published, listed extension with that id"),
      409: errorResponse("Stored badge fields require manual correction"),
      422: errorResponse(
        "Invalid badge type or color length (1–100 characters)"
      ),
      500: errorResponse("Database error")
    }
  });
  app.openapi(route, async (c) => {
    const { id, type } = c.req.valid("param");
    const { color } = c.req.valid("query");
    const db = new ExtensionBadgesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.getById(id);
    if (error || !data)
      return c.json(
        errorBody(error, "Unable to load badge"),
        statusFromContentReadError(error?.code)
      );

    const release = data.latestRelease;
    const fields = {
      version: {
        label: "Latest version",
        message: release ? `v${release.tag}` : "unknown"
      },
      fossbilling: {
        label: "FOSSBilling",
        message: release?.requires.fossbilling ?? "unknown"
      },
      license: { label: "License", message: data.license }
    };
    const svg = makeBadge({ ...fields[type], color: color ?? "blue" });
    c.header("Content-Type", "image/svg+xml");
    c.header("Cache-Control", "public, max-age=300, s-maxage=3600");
    return c.body(svg, 200);
  });
}
