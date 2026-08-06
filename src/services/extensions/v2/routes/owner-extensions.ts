import { errorBody } from "./errors";
import { requireActiveAuth } from "../middleware";
import { getExtensionsDb } from "../../../../lib/db";
import { getAuth } from "../../../../lib/auth";
import { createRoute } from "@hono/zod-openapi";
import {
  ActiveAccountRequiredResponse,
  errorResponse
} from "../schemas/common";
import {
  ExtensionListResponseSchema,
  ExtensionMineListQuerySchema
} from "../schemas/extensions";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import { ExtensionsDatabase, isValidExtensionCursor } from "../db/extensions";
import { ExtensionsV2App } from "./app";

export function registerOwnerExtensionsRoutes(app: ExtensionsV2App): void {
  const listMineRoute = createRoute({
    method: "get",
    path: "/extensions/mine",
    tags: ["Extensions"],
    summary: "List extensions published under the caller's developer profile",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: { query: ExtensionMineListQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": { schema: ExtensionListResponseSchema }
        },
        description: "The caller's published extensions"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: ActiveAccountRequiredResponse,
      422: errorResponse("Pagination query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(listMineRoute, async (c) => {
    const auth = getAuth(c);
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
      getExtensionsDb(c.env.DB_EXTENSIONS)
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

    const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const { data, error } = await db.list({
      type,
      developerId: owner.data.id,
      limit,
      cursor
    });
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to load extensions"),
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
