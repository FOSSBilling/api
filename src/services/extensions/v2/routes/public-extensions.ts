import { createRoute, z } from "@hono/zod-openapi";
import { statusFromErrorCode } from "./errors";
import { IdParamSchema, errorResponse } from "../schemas/common";
import {
  ExtensionListQuerySchema,
  ExtensionListResponseSchema,
  ExtensionSchema
} from "../schemas/extensions";
import { ExtensionsDatabase } from "../db/extensions";
import { ExtensionsV2App, RouteDependencies } from "./dependencies";

export function registerPublicExtensionsRoutes(
  app: ExtensionsV2App,
  dependencies: RouteDependencies
): void {
  const listExtensionsRoute = createRoute({
    method: "get",
    path: "/extensions",
    tags: ["Extensions"],
    summary: "List published extensions",
    request: { query: ExtensionListQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: ExtensionListResponseSchema
          }
        },
        description: "Extensions matching the given filters"
      },
      422: errorResponse("Filter or pagination query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(listExtensionsRoute, async (c) => {
    const { type, developer_id, limit, cursor } = c.req.valid("query");
    const db = new ExtensionsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.list({
      type,
      developerId: developer_id,
      limit,
      cursor
    });
    if (error || !data) {
      return c.json(
        {
          error: {
            message: error?.message ?? "Unable to load extensions",
            code: error?.code ?? "DATABASE_ERROR"
          }
        },
        error?.code === "INVALID_CURSOR" ? 422 : 500
      );
    }
    return c.json(
      {
        result: data.items,
        pagination: {
          next_cursor: data.nextCursor,
          has_more: data.hasMore
        }
      },
      200
    );
  });

  const getExtensionRoute = createRoute({
    method: "get",
    path: "/extensions/{id}",
    tags: ["Extensions"],
    summary: "Get a single published extension",
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ result: ExtensionSchema }) }
        },
        description: "The extension"
      },
      404: errorResponse("No extension with that id"),
      422: errorResponse("id param failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(getExtensionRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = new ExtensionsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.getById(id);
    if (error || !data) {
      const status = statusFromErrorCode(error?.code, false);
      return c.json(
        {
          error: {
            message: error?.message ?? "Extension not found",
            code: error?.code ?? "DATABASE_ERROR"
          }
        },
        status
      );
    }
    return c.json({ result: data }, 200);
  });
}
