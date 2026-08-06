import { createRoute } from "@hono/zod-openapi";
import {
  ActiveAccountRequiredResponse,
  ErrorResponseSchema,
  ExtensionListResponseSchema,
  ExtensionMineListQuerySchema
} from "./interfaces";
import { DeveloperProfilesDatabase } from "./developer-profiles-database";
import {
  ExtensionsDatabase,
  isValidExtensionCursor
} from "./extensions-database";
import { ExtensionsV2App, RouteDependencies } from "./route-dependencies";

export function registerOwnerExtensionsRoutes(
  app: ExtensionsV2App,
  dependencies: RouteDependencies
): void {
  const listMineRoute = createRoute({
    method: "get",
    path: "/extensions/mine",
    tags: ["Extensions"],
    summary: "List extensions published under the caller's developer profile",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireAuth()] as const,
    request: { query: ExtensionMineListQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": { schema: ExtensionListResponseSchema }
        },
        description: "The caller's published extensions"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: ActiveAccountRequiredResponse,
      422: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Pagination query failed validation"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(listMineRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { type, limit, cursor } = c.req.valid("query");

    // An account without a developer profile normally returns an empty page,
    // but malformed cursors are still client errors and must be rejected
    // before that early return.
    if (cursor && !isValidExtensionCursor(cursor)) {
      return c.json(
        {
          error: {
            message: "Invalid pagination cursor",
            code: "INVALID_CURSOR"
          }
        },
        422
      );
    }

    const ownerDb = new DeveloperProfilesDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const owner = await ownerDb.getOwn(auth.userId);
    if (owner.error) {
      return c.json(
        {
          error: {
            message: owner.error.message,
            code: owner.error.code ?? "DATABASE_ERROR"
          }
        },
        500
      );
    }
    if (!owner.data) {
      return c.json(
        { result: [], pagination: { next_cursor: null, has_more: false } },
        200
      );
    }

    const db = new ExtensionsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.list({
      type,
      developerId: owner.data.id,
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
}
