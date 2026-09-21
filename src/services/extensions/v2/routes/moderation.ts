import { requireModerator } from "../middleware";
import { getExtensionsDb } from "../../../../lib/db";
import { getPlatform } from "../../../../lib/middleware";
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
  ListPaginationQuerySchema,
  NotifyQuerySchema,
  OffsetPaginationSchema,
  ReviewNoteOptionalSchema,
  ReviewNoteRequiredSchema,
  errorResponse,
  offsetPageFromQuery,
  offsetPaginationFrom
} from "../schemas/common";
import {
  DeveloperApprovalSchema,
  DeveloperHistoryEntrySchema
} from "../schemas/developers";
import { RevisionIdParamSchema } from "../schemas/revisions";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import { ExtensionsDatabase } from "../db/extensions";
import { ExtensionRevisionsDatabase } from "../db/revisions";
import { notifyRequested, sendModerationNotification } from "../email/notify";
import { revalidateCatalogue } from "../revalidate";
import { ExtensionsV2App } from "./app";

export function registerModerationRoutes(app: ExtensionsV2App): void {
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
      query: NotifyQuerySchema,
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
                status: z.literal("approved"),
                notified: z
                  .boolean()
                  .describe(
                    "Whether a notification email was dispatched - delivery itself is asynchronous"
                  )
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
      422: errorResponse(
        "Path params, review_note body, or notify query failed validation"
      ),
      500: errorResponse("Database error")
    }
  });

  app.openapi(approveRoute, async (c) => {
    const auth = getAuth(c);
    const { id, revisionId } = c.req.valid("param");
    const { review_note } = c.req.valid("json");
    const query = c.req.valid("query");
    const extDb = getExtensionsDb(c.env.DB_EXTENSIONS);
    const db = new ExtensionRevisionsDatabase(extDb);
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
    revalidateCatalogue(c);
    let notified = false;
    if (notifyRequested(query)) {
      notified = await sendModerationNotification(
        getPlatform(c),
        extDb,
        {
          kind: "revision-approved",
          extensionId: id,
          // Optional and untrimmed by its schema: a whitespace-only note would
          // otherwise reach the author as a meaningless "Moderator note:".
          reason: review_note?.trim() || undefined
        },
        (p) => c.executionCtx.waitUntil(p)
      );
    }
    return c.json({ result: { ...data, notified } }, 200);
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
      query: NotifyQuerySchema,
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
                status: z.literal("rejected"),
                notified: z
                  .boolean()
                  .describe(
                    "Whether a notification email was dispatched - delivery itself is asynchronous"
                  )
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
      422: errorResponse("review_note body or notify query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(rejectRoute, async (c) => {
    const auth = getAuth(c);
    const { id, revisionId } = c.req.valid("param");
    const { review_note } = c.req.valid("json");
    const query = c.req.valid("query");
    const extDb = getExtensionsDb(c.env.DB_EXTENSIONS);
    const db = new ExtensionRevisionsDatabase(extDb);
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
    revalidateCatalogue(c);
    let notified = false;
    if (notifyRequested(query)) {
      notified = await sendModerationNotification(
        getPlatform(c),
        extDb,
        {
          kind: "revision-rejected",
          extensionId: id,
          reason: review_note
        },
        (p) => c.executionCtx.waitUntil(p)
      );
    }
    return c.json({ result: { ...data, notified } }, 200);
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
      query: NotifyQuerySchema,
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
                status: z.literal("delisted"),
                notified: z
                  .boolean()
                  .describe(
                    "Whether a notification email was dispatched - delivery itself is asynchronous"
                  )
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
      422: errorResponse(
        "Path params, reason body, or notify query failed validation"
      ),
      500: errorResponse("Database error")
    }
  });

  app.openapi(delistRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const query = c.req.valid("query");
    const extDb = getExtensionsDb(c.env.DB_EXTENSIONS);
    const db = new ExtensionsDatabase(extDb);
    const { data, error } = await db.delist(id, auth.userId, reason);
    if (error || !data) {
      const status = statusFromWriteErrorCode(error?.code);
      return c.json(errorBody(error, "Unable to delist extension"), status);
    }
    revalidateCatalogue(c);
    let notified = false;
    if (notifyRequested(query)) {
      notified = await sendModerationNotification(
        getPlatform(c),
        extDb,
        {
          kind: "extension-delisted",
          extensionId: id,
          reason
        },
        (p) => c.executionCtx.waitUntil(p)
      );
    }
    return c.json(
      { result: { id: data.id, status: "delisted" as const, notified } },
      200
    );
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
      query: NotifyQuerySchema,
      body: {
        content: { "application/json": { schema: DeveloperApprovalSchema } }
      }
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({
                id: z.string(),
                approved: z.literal(true),
                notified: z
                  .boolean()
                  .describe(
                    "Whether a notification email was dispatched - delivery itself is asynchronous"
                  )
              })
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
      422: errorResponse("id param or notify query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(approveDeveloperRoute, async (c) => {
    const auth = getAuth(c);
    const { id } = c.req.valid("param");
    const { expected_revision } = c.req.valid("json");
    const query = c.req.valid("query");
    const extDb = getExtensionsDb(c.env.DB_EXTENSIONS);
    const db = new DeveloperProfilesDatabase(extDb);
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
    revalidateCatalogue(c);
    let notified = false;
    if (notifyRequested(query)) {
      notified = await sendModerationNotification(
        getPlatform(c),
        extDb,
        {
          kind: "developer-approved",
          developerId: id
        },
        (p) => c.executionCtx.waitUntil(p)
      );
    }
    return c.json({ result: { ...data, notified } }, 200);
  });

  const developerHistoryRoute = createRoute({
    method: "get",
    path: "/developers/{id}/history",
    tags: ["Moderation"],
    summary: "List the write history of a developer profile",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    request: { params: IdParamSchema, query: ListPaginationQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.array(DeveloperHistoryEntrySchema),
              pagination: OffsetPaginationSchema.optional()
            })
          }
        },
        description: "Snapshots of the profile, newest first"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      422: errorResponse("id param or pagination query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(developerHistoryRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");
    const page = offsetPageFromQuery({ limit, offset });
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.listHistory(id, page);
    if (error || !data) {
      return c.json(errorBody(error, "Unable to load developer history"), 500);
    }
    return c.json(
      {
        result: data.items,
        pagination: offsetPaginationFrom(page, data.hasMore)
      },
      200
    );
  });

  // Queue totals behind the admin tabs. Two small aggregate queries rather
  // than per-status COUNTs, and deliberately separate from the list
  // endpoints so pagination contracts stay untouched.
  const countsRoute = createRoute({
    method: "get",
    path: "/moderation/counts",
    tags: ["Moderation"],
    summary: "Queue totals for the admin tabs",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({
                revisions: z.object({
                  pending: z.number(),
                  approved: z.number(),
                  rejected: z.number()
                }),
                extensions: z.object({
                  all: z.number(),
                  published: z.number(),
                  delisted: z.number(),
                  unpublished: z.number()
                })
              })
            })
          }
        },
        description: "Pending/decided totals per queue"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      500: errorResponse("Database error")
    }
  });

  app.openapi(countsRoute, async (c) => {
    const extDb = getExtensionsDb(c.env.DB_EXTENSIONS);
    const [revisions, extensionCounts] = await Promise.all([
      new ExtensionRevisionsDatabase(extDb).countByStatus(),
      new ExtensionsDatabase(extDb).countForModeration()
    ]);
    const error = revisions.error ?? extensionCounts.error;
    if (error || !revisions.data || !extensionCounts.data) {
      return c.json(errorBody(error, "Unable to load moderation counts"), 500);
    }
    const res = c.json(
      {
        result: { revisions: revisions.data, extensions: extensionCounts.data }
      },
      200
    );
    res.headers.set("Vary", "Authorization");
    return res;
  });
}
