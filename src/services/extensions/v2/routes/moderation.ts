import { requireModerator } from "../middleware";
import { getExtensionsDb } from "../../../../lib/db";
import { getAuth } from "../../../../lib/auth";
import { createRoute, z } from "@hono/zod-openapi";
import {
  errorBody,
  statusFromErrorCode,
  statusFromWriteErrorCode
} from "./errors";
import {
  ActiveAccountRequiredResponse,
  DelistReasonSchema,
  IdParamSchema,
  PaginationSchema,
  ReviewNoteOptionalSchema,
  ReviewNoteRequiredSchema,
  errorResponse
} from "../schemas/common";
import {
  DeveloperApprovalSchema,
  DeveloperHistoryEntrySchema,
  DeveloperProfileSchema
} from "../schemas/developers";
import {
  ExtensionRevisionSchema,
  RevisionIdParamSchema,
  RevisionQueueQuerySchema
} from "../schemas/revisions";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import { ExtensionsDatabase } from "../db/extensions";
import { ExtensionRevisionsDatabase } from "../db/revisions";
import { ExtensionsV2App } from "./app";

export function registerModerationRoutes(app: ExtensionsV2App): void {
  const queueRoute = createRoute({
    method: "get",
    path: "/moderation/extensions",
    tags: ["Moderation"],
    summary: "List extension revisions awaiting review",
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

  app.openapi(queueRoute, async (c) => {
    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { status, limit, cursor } = c.req.valid("query");
    const { data, error } = await db.listQueue(
      status ?? "pending",
      limit,
      cursor
    );
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to load queue"),
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

  // Reviews are addressed through the extension they belong to. The revision
  // id alone would be enough to find the row, but scoping the path to the
  // extension means a moderator acting from a queue entry cannot approve a
  // revision of a different extension than the one they were looking at.
  const approveRoute = createRoute({
    method: "post",
    path: "/extensions/{id}/revisions/{revisionId}/approve",
    tags: ["Moderation"],
    summary: "Approve a pending revision and publish it",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    request: {
      params: RevisionIdParamSchema,
      body: {
        content: { "application/json": { schema: ReviewNoteOptionalSchema } }
      }
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({
                id: z.string(),
                status: z.literal("approved")
              })
            })
          }
        },
        description:
          "Revision approved and published as the extension's live content"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      404: errorResponse("No such revision on that extension"),
      409: errorResponse(
        "Revision is not pending, or ownership has changed since it was proposed"
      ),
      422: errorResponse("Path params or review_note body failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(approveRoute, async (c) => {
    const auth = getAuth(c);
    const { id, revisionId } = c.req.valid("param");
    const { review_note } = c.req.valid("json");
    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.approve(
      id,
      revisionId,
      auth.userId,
      review_note
    );
    if (error || !data) {
      const status = statusFromWriteErrorCode(error?.code);
      return c.json(errorBody(error, "Unable to approve revision"), status);
    }
    return c.json({ result: data }, 200);
  });

  const rejectRoute = createRoute({
    method: "post",
    path: "/extensions/{id}/revisions/{revisionId}/reject",
    tags: ["Moderation"],
    summary: "Reject a pending revision",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    request: {
      params: RevisionIdParamSchema,
      body: {
        content: { "application/json": { schema: ReviewNoteRequiredSchema } }
      }
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({
                id: z.string(),
                status: z.literal("rejected")
              })
            })
          }
        },
        description:
          "Revision rejected. The extension's published content is unchanged."
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      404: errorResponse("No such revision on that extension"),
      409: errorResponse("Revision is not pending"),
      422: errorResponse("review_note is required"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(rejectRoute, async (c) => {
    const auth = getAuth(c);
    const { id, revisionId } = c.req.valid("param");
    const { review_note } = c.req.valid("json");
    const db = new ExtensionRevisionsDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.reject(
      id,
      revisionId,
      auth.userId,
      review_note
    );
    if (error || !data) {
      const status = statusFromWriteErrorCode(error?.code);
      return c.json(errorBody(error, "Unable to reject revision"), status);
    }
    return c.json({ result: data }, 200);
  });

  // Distinct from reject: reject leaves a pending edit unpublished, delist
  // pulls an already-published extension out of the catalogue entirely. See
  // ExtensionsDatabase.delist() for why content and history are kept rather
  // than cleared.
  const delistRoute = createRoute({
    method: "post",
    path: "/extensions/{id}/delist",
    tags: ["Moderation"],
    summary: "Remove a published extension from the public catalogue",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    request: {
      params: IdParamSchema,
      body: {
        content: { "application/json": { schema: DelistReasonSchema } }
      }
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({
                id: z.string(),
                status: z.literal("delisted")
              })
            })
          }
        },
        description:
          "Extension removed from the public catalogue. Its content and " +
          "history are kept, and its owner can still see and edit it."
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      404: errorResponse("No such extension"),
      409: errorResponse("Extension is not published, or is already delisted"),
      422: errorResponse("Path params or reason body failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(delistRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const { data, error } = await db.delist(id, auth.userId, reason);
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to delist extension"),
        statusFromWriteErrorCode(error?.code)
      );
    }
    return c.json(
      { result: { id: data.id, status: "delisted" as const } },
      200
    );
  });

  const allDevelopersRoute = createRoute({
    method: "get",
    path: "/developers",
    tags: ["Moderation"],
    summary: "List every developer profile, approved or not",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: z.array(DeveloperProfileSchema) })
          }
        },
        description: "All developer profiles"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      500: errorResponse("Database error")
    }
  });

  app.openapi(allDevelopersRoute, async (c) => {
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.listAll();
    if (error || !data) {
      return c.json(
        {
          error: {
            message: error?.message ?? "Unable to load developers",
            code: "DATABASE_ERROR"
          }
        },
        500
      );
    }
    return c.json({ result: data }, 200);
  });

  const unapprovedDevelopersRoute = createRoute({
    method: "get",
    path: "/developers/unapproved",
    tags: ["Moderation"],
    summary: "List developer profiles awaiting moderator review",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: z.array(DeveloperProfileSchema) })
          }
        },
        description: "Developer profiles not yet approved"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      500: errorResponse("Database error")
    }
  });

  app.openapi(unapprovedDevelopersRoute, async (c) => {
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.listUnapproved();
    if (error || !data) {
      return c.json(
        {
          error: {
            message: error?.message ?? "Unable to load unapproved developers",
            code: "DATABASE_ERROR"
          }
        },
        500
      );
    }
    return c.json({ result: data }, 200);
  });
  const approveDeveloperRoute = createRoute({
    method: "post",
    path: "/developers/{id}/approve",
    tags: ["Moderation"],
    summary: "Mark a developer profile as reviewed/approved",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    request: {
      params: IdParamSchema,
      body: {
        content: { "application/json": { schema: DeveloperApprovalSchema } }
      }
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({ id: z.string(), approved: z.literal(true) })
            })
          }
        },
        description: "Developer profile marked approved"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      404: errorResponse("No developer with that id"),
      409: errorResponse("Profile changed after the reviewed revision"),
      422: errorResponse("id param failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(approveDeveloperRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const { expected_revision } = c.req.valid("json");
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.approve(
      id,
      expected_revision,
      auth.userId
    );
    if (error || !data) {
      const status =
        error?.code === "ACCOUNT_INACTIVE"
          ? 403
          : statusFromErrorCode(error?.code);
      return c.json(errorBody(error, "Unable to approve developer"), status);
    }
    return c.json({ result: data }, 200);
  });

  const developerHistoryRoute = createRoute({
    method: "get",
    path: "/developers/{id}/history",
    tags: ["Moderation"],
    summary: "List the write history of a developer profile",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: z.array(DeveloperHistoryEntrySchema) })
          }
        },
        description: "Snapshots of the profile, newest first"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      422: errorResponse("id param failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(developerHistoryRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.listHistory(id);
    if (error || !data) {
      return c.json(errorBody(error, "Unable to load developer history"), 500);
    }
    return c.json({ result: data }, 200);
  });
}
