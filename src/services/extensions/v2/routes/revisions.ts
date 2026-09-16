import { getExtensionsDb } from "../../../../lib/db";
import { createRoute, z } from "@hono/zod-openapi";
import { errorBody, statusFromErrorCode } from "./errors";
import {
  ActiveAccountRequiredResponse,
  PaginationSchema,
  errorResponse
} from "../schemas/common";
import {
  ExtensionRevisionSchema,
  UnifiedRevisionsQuerySchema
} from "../schemas/revisions";
import { ExtensionsDatabase } from "../db/extensions";
import { ExtensionRevisionsDatabase } from "../db/revisions";
import { UsersDatabase } from "../db/users";
import { getOptionalAuth, optionalAuth } from "../middleware";
import { ExtensionsV2App } from "./app";

export function registerRevisionRoutes(app: ExtensionsV2App): void {
  const listRevisionsRoute = createRoute({
    method: "get",
    path: "/revisions",
    tags: ["Extensions"],
    summary:
      "List revisions: per-extension history (?extension_id=, owner-or-moderator) or global review queue (moderator)",
    security: [{ Bearer: [] }],
    middleware: [optionalAuth()] as const,
    request: { query: UnifiedRevisionsQuerySchema },
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
          "Revisions newest first for per-extension history, oldest first for the queue unless ?sort= overrides"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "Inactive account, non-owner reading another extension's history, or non-moderator reading the queue"
      },
      404: errorResponse("No extension with that extension_id"),
      422: errorResponse("Query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(listRevisionsRoute, async (c) => {
    const { extension_id, status, sort, limit, cursor } = c.req.valid("query");
    const auth = getOptionalAuth(c);
    if (!auth) {
      return c.json(
        { error: { message: "Missing bearer token", code: "UNAUTHORIZED" } },
        401,
        { "WWW-Authenticate": "Bearer" }
      );
    }
    const extDb = getExtensionsDb(c.env.DB_EXTENSIONS);
    const users = new UsersDatabase(extDb);

    if (extension_id) {
      const extensionsDb = new ExtensionsDatabase(extDb);
      const owned = await extensionsDb.getOwned(extension_id);
      if (owned.error || !owned.data) {
        return c.json(
          errorBody(owned.error, "Extension not found"),
          statusFromErrorCode(owned.error?.code, false)
        );
      }
      const callerId = auth.userId;
      if (owned.data.ownerUserId !== callerId) {
        const moderator = await users.moderatorAccess(callerId);
        if (moderator.error) {
          return c.json(
            errorBody(moderator.error, "Unable to check moderator access"),
            500
          );
        }
        if (!moderator.data?.active) {
          return c.json(
            {
              error: {
                message: "Active account required",
                code: "ACCOUNT_INACTIVE"
              }
            },
            403
          );
        }
        if (!moderator.data.moderator) {
          return c.json(
            {
              error: {
                message: "You do not own this extension",
                code: "FORBIDDEN"
              }
            },
            403
          );
        }
      } else {
        const active = await users.isActive(callerId);
        if (active.error) {
          return c.json(
            errorBody(active.error, "Unable to check account"),
            500
          );
        }
        if (!active.data) {
          return c.json(
            {
              error: {
                message: "Active account required",
                code: "ACCOUNT_INACTIVE"
              }
            },
            403
          );
        }
      }
      const db = new ExtensionRevisionsDatabase(extDb);
      const { data, error } = await db.listScoped({
        extensionId: owned.data.extension.id,
        status,
        sort,
        limit,
        cursor
      });
      if (error || !data) {
        return c.json(
          errorBody(error, "Unable to load revisions"),
          error?.code === "INVALID_CURSOR" ? 422 : 500
        );
      }
      const historyRes = c.json(
        {
          result: data.items,
          pagination: { next_cursor: data.nextCursor, has_more: data.hasMore }
        },
        200
      );
      historyRes.headers.set("Vary", "Authorization");
      return historyRes;
    }

    const access = await users.moderatorAccess(auth.userId);
    if (access.error) {
      return c.json(errorBody(access.error, "Unable to check access"), 500);
    }
    if (!access.data?.active) {
      return c.json(
        {
          error: {
            message: "Active account required",
            code: "ACCOUNT_INACTIVE"
          }
        },
        403
      );
    }
    if (!access.data.moderator) {
      return c.json(
        { error: { message: "Moderator access required", code: "FORBIDDEN" } },
        403
      );
    }
    const db = new ExtensionRevisionsDatabase(extDb);
    const { data, error } = await db.listScoped({
      status: status ?? "pending",
      sort,
      limit,
      cursor
    });
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to load queue"),
        error?.code === "INVALID_CURSOR" ? 422 : 500
      );
    }
    const queueRes = c.json(
      {
        result: data.items,
        pagination: { next_cursor: data.nextCursor, has_more: data.hasMore }
      },
      200
    );
    queueRes.headers.set("Vary", "Authorization");
    return queueRes;
  });
}
