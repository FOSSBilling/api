import { getExtensionsDb } from "../../../../lib/db";
import { createRoute } from "@hono/zod-openapi";
import { errorBody, statusFromErrorCode } from "./errors";
import { IdParamSchema, errorResponse } from "../schemas/common";
import {
  UnifiedExtensionListQuerySchema,
  UnifiedExtensionListResponseSchema,
  ExtensionDetailResponseSchema
} from "../schemas/extensions";
import { ExtensionsDatabase, isValidExtensionCursor } from "../db/extensions";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import { UsersDatabase } from "../db/users";
import { getOptionalAuth, optionalAuth } from "../middleware";
import { ExtensionsV2App } from "./app";

export function registerPublicExtensionsRoutes(app: ExtensionsV2App): void {
  const listExtensionsRoute = createRoute({
    method: "get",
    path: "/extensions",
    tags: ["Extensions"],
    summary:
      "List extensions: published catalogue (scope=public), caller's own (scope=mine), or every extension (scope=all, moderator)",
    security: [{ Bearer: [] }],
    middleware: [optionalAuth()] as const,
    request: { query: UnifiedExtensionListQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: UnifiedExtensionListResponseSchema
          }
        },
        description:
          "Extensions matching the scope: catalogue cards for scope=public, owned rows for scope=mine/all"
      },
      401: errorResponse("Invalid bearer token"),
      403: errorResponse(
        "Inactive account, non-moderator scope=all, or scope misuse"
      ),
      422: errorResponse("Filter or pagination query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(listExtensionsRoute, async (c) => {
    const { scope, type, developer_id, status, q, limit, cursor } =
      c.req.valid("query");
    const auth = getOptionalAuth(c);
    const extDb = getExtensionsDb(c.env.DB_EXTENSIONS);

    // Filter/scope combinations are rejected rather than silently ignored so
    // a caller cannot mistake one projection for another.
    if (scope !== "public" && developer_id !== undefined) {
      return c.json(
        {
          error: {
            message: "developer_id is only valid with scope=public",
            code: "VALIDATION_ERROR"
          }
        },
        422
      );
    }
    if (scope !== "all" && (status !== undefined || q !== undefined)) {
      return c.json(
        {
          error: {
            message: "status and q are only valid with scope=all",
            code: "VALIDATION_ERROR"
          }
        },
        422
      );
    }

    if (scope === "public") {
      const db = new ExtensionsDatabase(extDb);
      const { data, error } = await db.list({
        type,
        developerId: developer_id,
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
    }

    if (!auth) {
      return c.json(
        {
          error: {
            message: "Missing bearer token",
            code: "UNAUTHORIZED"
          }
        },
        401,
        { "WWW-Authenticate": "Bearer" }
      );
    }

    const users = new UsersDatabase(extDb);
    if (scope === "mine") {
      const active = await users.isActive(auth.userId);
      if (active.error) {
        return c.json(errorBody(active.error, "Unable to check account"), 500);
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
      const owner = await new DeveloperProfilesDatabase(extDb).getOwnRef(
        auth.userId
      );
      if (owner.error) {
        return c.json(errorBody(owner.error, "Unable to load developer"), 500);
      }
      if (!owner.data) {
        return c.json(
          { result: [], pagination: { next_cursor: null, has_more: false } },
          200
        );
      }
      const db = new ExtensionsDatabase(extDb);
      const { data, error } = await db.listOwned({
        developerId: owner.data.id,
        type,
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
          pagination: { next_cursor: data.nextCursor, has_more: data.hasMore }
        },
        200
      );
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
    const db = new ExtensionsDatabase(extDb);
    const { data, error } = await db.listForModeration({
      status,
      type,
      q,
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
        pagination: { next_cursor: data.nextCursor, has_more: data.hasMore }
      },
      200
    );
  });

  const getExtensionRoute = createRoute({
    method: "get",
    path: "/extensions/{id}",
    tags: ["Extensions"],
    summary:
      "Get an extension: published content anonymously, full owned record for its owner or a moderator",
    security: [{ Bearer: [] }],
    middleware: [optionalAuth()] as const,
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: {
          "application/json": { schema: ExtensionDetailResponseSchema }
        },
        description:
          "Published projection for anonymous/unrelated callers, owned projection for the owner or a moderator"
      },
      401: errorResponse("Invalid bearer token"),
      404: errorResponse("No extension with that id"),
      422: errorResponse("id param failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(getExtensionRoute, async (c) => {
    const { id } = c.req.valid("param");
    const auth = getOptionalAuth(c);
    const extDb = getExtensionsDb(c.env.DB_EXTENSIONS);
    const db = new ExtensionsDatabase(extDb);

    if (auth) {
      const owned = await db.getOwned(id);
      if (owned.data) {
        const users = new UsersDatabase(extDb);
        if (owned.data.ownerUserId === auth.userId) {
          const active = await users.isActive(auth.userId);
          if (active.error) {
            return c.json(
              errorBody(active.error, "Unable to check account"),
              500
            );
          }
          if (active.data) return c.json({ result: owned.data.extension }, 200);
        } else {
          const access = await users.moderatorAccess(auth.userId);
          if (access.error) {
            return c.json(
              errorBody(access.error, "Unable to check access"),
              500
            );
          }
          if (access.data?.moderator) {
            return c.json({ result: owned.data.extension }, 200);
          }
        }
      } else if (owned.error && owned.error.code !== "NOT_FOUND") {
        return c.json(errorBody(owned.error, "Extension not found"), 500);
      }
    }

    const { data, error } = await db.getById(id);
    if (error || !data) {
      const status = statusFromErrorCode(error?.code, false);
      return c.json(errorBody(error, "Extension not found"), status);
    }
    const res = c.json({ result: data }, 200);
    if (!auth) {
      res.headers.set(
        "Cache-Control",
        "public, max-age=60, s-maxage=300, stale-while-revalidate=600"
      );
    } else {
      res.headers.set("Vary", "Authorization");
    }
    return res;
  });
}
