import {
  errorBody,
  statusFromErrorCode,
  statusFromWriteErrorCode
} from "./errors";
import { requireActiveAuth } from "../middleware";
import { getExtensionsDb } from "../../../../lib/db";
import { getAuth } from "../../../../lib/auth";
import { createRoute, z } from "@hono/zod-openapi";
import {
  ActiveAccountRequiredResponse,
  IdParamSchema,
  PaginationSchema,
  errorResponse
} from "../schemas/common";
import {
  ExtensionCreateSchema,
  ExtensionMineListQuerySchema,
  ExtensionUpdateSchema,
  OwnedExtensionListResponseSchema,
  OwnedExtensionSchema
} from "../schemas/extensions";
import {
  ExtensionRevisionSchema,
  RevisionPageQuerySchema
} from "../schemas/revisions";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import { ExtensionsDatabase, isValidExtensionCursor } from "../db/extensions";
import { ExtensionRevisionsDatabase } from "../db/revisions";
import { UsersDatabase } from "../db/users";
import { ExtensionsV2App } from "./app";

const AcceptedRevisionSchema = z.object({
  result: z.object({
    id: z.string(),
    revision_id: z.string(),
    status: z.literal("pending")
  })
});

export function registerOwnerExtensionsRoutes(app: ExtensionsV2App): void {
  const listMineRoute = createRoute({
    method: "get",
    path: "/extensions/mine",
    tags: ["Extensions"],
    summary: "List the caller's extensions, published or not",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: { query: ExtensionMineListQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": { schema: OwnedExtensionListResponseSchema }
        },
        description:
          "Every extension under the caller's developer profile, each with its live content, any unreviewed edit, and the last moderator decision"
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

    const owner = await new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    ).getOwnRef(auth.userId);
    if (owner.error) {
      return c.json(errorBody(owner.error, "Unable to load developer"), 500);
    }
    if (!owner.data) {
      return c.json(
        { result: [], pagination: { next_cursor: null, has_more: false } },
        200
      );
    }

    const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
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
  });

  const getMineRoute = createRoute({
    method: "get",
    path: "/extensions/mine/{id}",
    tags: ["Extensions"],
    summary: "Get one of the caller's extensions, published or not",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: OwnedExtensionSchema })
          }
        },
        description:
          "The extension's live content, its unreviewed edit if any, and the last moderator decision"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller does not own this extension"
      },
      404: errorResponse("No extension with that id"),
      422: errorResponse("id param failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(getMineRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const { data, error } = await db.getOwned(id);
    if (error || !data) {
      return c.json(
        errorBody(error, "Extension not found"),
        statusFromErrorCode(error?.code, false)
      );
    }
    if (data.ownerUserId !== auth.userId) {
      return c.json(
        {
          error: { message: "You do not own this extension", code: "FORBIDDEN" }
        },
        403
      );
    }
    return c.json({ result: data.extension }, 200);
  });

  const createRouteDefinition = createRoute({
    method: "post",
    path: "/extensions",
    tags: ["Extensions"],
    summary: "Create an extension and submit its first version for review",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: {
      body: {
        content: { "application/json": { schema: ExtensionCreateSchema } }
      }
    },
    responses: {
      201: {
        content: { "application/json": { schema: AcceptedRevisionSchema } },
        description:
          "Extension created. It holds the id immediately but stays out of the public catalogue until a moderator approves the revision."
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller has no developer profile to publish under"
      },
      409: errorResponse(
        "The id is taken, ownership changed, or the pending-revision limit was reached"
      ),
      422: errorResponse("Body failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(createRouteDefinition, async (c) => {
    const auth = getAuth(c);
    const { id, ...content } = c.req.valid("json");

    const owner = await new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    ).getOwnRef(auth.userId);
    if (owner.error) {
      return c.json(errorBody(owner.error, "Unable to load developer"), 500);
    }
    if (!owner.data) {
      return c.json(
        {
          error: {
            message:
              "You need a developer profile before publishing — create one with PUT /developers/me",
            code: "FORBIDDEN"
          }
        },
        403
      );
    }

    const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const { data, error } = await db.create({
      extensionId: id,
      developerId: owner.data.id,
      ownershipEpoch: owner.data.ownershipEpoch,
      submittedBy: auth.userId,
      content
    });
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to create extension"),
        statusFromWriteErrorCode(error?.code, false)
      );
    }
    return c.json(
      {
        result: {
          id: data.id,
          revision_id: data.revisionId,
          status: "pending" as const
        }
      },
      201
    );
  });

  const updateRoute = createRoute({
    method: "put",
    path: "/extensions/{id}",
    tags: ["Extensions"],
    summary: "Submit an edit to an extension the caller owns",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: {
      params: IdParamSchema,
      body: {
        content: { "application/json": { schema: ExtensionUpdateSchema } }
      }
    },
    responses: {
      202: {
        content: { "application/json": { schema: AcceptedRevisionSchema } },
        description:
          "Edit accepted as a pending revision. The published content is unchanged until a moderator approves it."
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller does not own this extension"
      },
      404: errorResponse("No extension with that id"),
      409: errorResponse(
        "An edit is already awaiting review, or the pending-revision limit was reached"
      ),
      422: errorResponse("Body failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(updateRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const content = c.req.valid("json");
    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.propose({
      extensionId: id,
      callerId: auth.userId,
      content
    });
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to submit edit"),
        statusFromWriteErrorCode(error?.code)
      );
    }
    return c.json(
      { result: { id, revision_id: data.id, status: "pending" as const } },
      202
    );
  });

  const withdrawRoute = createRoute({
    method: "delete",
    path: "/extensions/{id}",
    tags: ["Extensions"],
    summary: "Withdraw an extension that has never been published",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({ id: z.string(), deleted: z.literal(true) })
            })
          }
        },
        description: "Extension and its revisions deleted, and the id released"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller does not own this extension"
      },
      404: errorResponse("No extension with that id"),
      409: errorResponse("The extension is published and cannot be withdrawn"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(withdrawRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const { data, error } = await db.withdraw(id, auth.userId);
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to withdraw extension"),
        statusFromWriteErrorCode(error?.code)
      );
    }
    return c.json({ result: { id: data.id, deleted: true as const } }, 200);
  });

  const revisionsRoute = createRoute({
    method: "get",
    path: "/extensions/{id}/revisions",
    tags: ["Extensions"],
    summary: "List an extension's revisions, newest first",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    request: { params: IdParamSchema, query: RevisionPageQuerySchema },
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
          "Every version proposed for this extension, with its review outcome"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller neither owns this extension nor moderates"
      },
      404: errorResponse("No extension with that id"),
      422: errorResponse("Pagination query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(revisionsRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");
    const extensionsDb = new ExtensionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const owned = await extensionsDb.getOwned(id);
    if (owned.error || !owned.data) {
      return c.json(
        errorBody(owned.error, "Extension not found"),
        statusFromErrorCode(owned.error?.code, false)
      );
    }

    if (owned.data.ownerUserId !== auth.userId) {
      const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
      const moderator = await users.moderatorAccess(auth.userId);
      if (moderator.error) {
        return c.json(
          errorBody(moderator.error, "Unable to check moderator access"),
          500
        );
      }
      if (!moderator.data?.moderator) {
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
    }

    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.listByExtension(
      owned.data.extension.id,
      limit,
      cursor
    );
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to load revisions"),
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
}
