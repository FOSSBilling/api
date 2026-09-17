import { getExtensionsDb } from "../../../../lib/db";
import { createRoute, z } from "@hono/zod-openapi";
import { errorBody } from "./errors";
import {
  ActiveAccountRequiredResponse,
  PaginationSchema,
  errorResponse
} from "../schemas/common";
import {
  ExtensionRevisionSchema,
  RevisionQueueQuerySchema
} from "../schemas/revisions";
import { ExtensionRevisionsDatabase } from "../db/revisions";
import { requireModerator } from "../middleware";
import { ExtensionsV2App } from "./app";

export function registerRevisionRoutes(app: ExtensionsV2App): void {
  const listRevisionsRoute = createRoute({
    method: "get",
    path: "/revisions",
    tags: ["Moderation"],
    summary: "List extension revisions awaiting review, oldest first",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    request: { query: RevisionQueueQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.array(ExtensionRevisionSchema),
              pagination: PaginationSchema
            })
          }
        },
        description:
          "Revisions matching the requested status (default: pending), oldest first"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      422: errorResponse("status query param failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(listRevisionsRoute, async (c) => {
    const { status, limit, cursor } = c.req.valid("query");
    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.listScoped({
      status: status ?? "pending",
      sort: "oldest",
      limit,
      cursor
    });
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to load queue"),
        error?.code === "INVALID_CURSOR" ? 422 : 500
      );
    }
    const res = c.json(
      {
        result: data.items,
        pagination: { next_cursor: data.nextCursor, has_more: data.hasMore }
      },
      200
    );
    res.headers.set("Vary", "Authorization");
    return res;
  });
}
