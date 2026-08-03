import { createRoute, z } from "@hono/zod-openapi";
import { statusFromErrorCode } from "./route-errors";
import {
  ErrorResponseSchema,
  ExtensionListQuerySchema,
  ExtensionListResponseSchema,
  ExtensionSchema,
  IdParamSchema
} from "./interfaces";
import { ExtensionsDatabase } from "./extensions-database";
import { ExtensionsV2App, RouteDependencies } from "./route-dependencies";

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
      422: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Filter or pagination query failed validation"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
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
      404: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "No extension with that id"
      },
      422: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "id param failed validation"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
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
