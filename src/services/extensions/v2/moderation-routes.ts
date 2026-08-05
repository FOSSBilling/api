import { createRoute, z } from "@hono/zod-openapi";
import { statusFromErrorCode } from "./route-errors";
import {
  ActiveAccountRequiredResponse,
  DeveloperApprovalSchema,
  DeveloperHistoryEntrySchema,
  DeveloperProfileSchema,
  ErrorResponseSchema,
  IdParamSchema,
  PaginationSchema,
  QueueQuerySchema,
  ReviewNoteOptionalSchema,
  ReviewNoteRequiredSchema,
  SubmissionSchema
} from "./interfaces";
import { DevelopersDatabase } from "./developers-database";
import { SubmissionsDatabase } from "./submissions-database";
import { ExtensionsV2App, RouteDependencies } from "./route-dependencies";

export function registerModerationRoutes(
  app: ExtensionsV2App,
  dependencies: RouteDependencies
): void {
  const queueRoute = createRoute({
    method: "get",
    path: "/submissions/queue",
    tags: ["Moderation"],
    summary: "List submissions in the moderation queue",
    security: [{ Bearer: [] }],
    middleware: [
      dependencies.requireAuth(),
      dependencies.requireModerator()
    ] as const,
    request: { query: QueueQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.array(SubmissionSchema),
              pagination: PaginationSchema
            })
          }
        },
        description:
          "Submissions matching the requested status (default: pending)"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      422: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "status query param failed validation"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(queueRoute, async (c) => {
    const db = new SubmissionsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { status, limit, cursor } = c.req.valid("query");
    const { data, error } = await db.listQueue(
      status ?? "pending",
      limit,
      cursor
    );
    if (error || !data) {
      return c.json(
        {
          error: {
            message: error?.message ?? "Unable to load queue",
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

  const approveRoute = createRoute({
    method: "post",
    path: "/submissions/{id}/approve",
    tags: ["Moderation"],
    summary: "Approve a pending submission",
    security: [{ Bearer: [] }],
    middleware: [
      dependencies.requireAuth(),
      dependencies.requireModerator()
    ] as const,
    request: {
      params: IdParamSchema,
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
          "Submission approved and written through to the live extension/developer"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      404: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "No submission with that id"
      },
      409: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description:
          "Submission is not pending, or ownership has changed since it was submitted"
      },
      422: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "id param or review_note body failed validation"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(approveRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { id } = c.req.valid("param");
    const { review_note } = c.req.valid("json");
    const db = new SubmissionsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.approve(id, auth.userId, review_note);
    if (error || !data) {
      const status = statusFromErrorCode(error?.code);
      return c.json(
        {
          error: {
            message: error?.message ?? "Unable to approve submission",
            code: error?.code ?? "DATABASE_ERROR"
          }
        },
        status
      );
    }
    return c.json({ result: data }, 200);
  });

  const rejectRoute = createRoute({
    method: "post",
    path: "/submissions/{id}/reject",
    tags: ["Moderation"],
    summary: "Reject a pending submission",
    security: [{ Bearer: [] }],
    middleware: [
      dependencies.requireAuth(),
      dependencies.requireModerator()
    ] as const,
    request: {
      params: IdParamSchema,
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
        description: "Submission rejected"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      404: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "No submission with that id"
      },
      409: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Submission is not pending"
      },
      422: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "review_note is required"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(rejectRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { id } = c.req.valid("param");
    const { review_note } = c.req.valid("json");
    const db = new SubmissionsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.reject(id, auth.userId, review_note);
    if (error || !data) {
      const status = statusFromErrorCode(error?.code);
      return c.json(
        {
          error: {
            message: error?.message ?? "Unable to reject submission",
            code: error?.code ?? "DATABASE_ERROR"
          }
        },
        status
      );
    }
    return c.json({ result: data }, 200);
  });

  const allDevelopersRoute = createRoute({
    method: "get",
    path: "/developers",
    tags: ["Moderation"],
    summary: "List every developer profile, approved or not",
    security: [{ Bearer: [] }],
    middleware: [
      dependencies.requireAuth(),
      dependencies.requireModerator()
    ] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: z.array(DeveloperProfileSchema) })
          }
        },
        description: "All developer profiles"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(allDevelopersRoute, async (c) => {
    const db = new DevelopersDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
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
    middleware: [
      dependencies.requireAuth(),
      dependencies.requireModerator()
    ] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: z.array(DeveloperProfileSchema) })
          }
        },
        description: "Developer profiles not yet approved"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(unapprovedDevelopersRoute, async (c) => {
    const db = new DevelopersDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
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
    middleware: [
      dependencies.requireAuth(),
      dependencies.requireModerator()
    ] as const,
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
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      404: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "No developer with that id"
      },
      409: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Profile changed after the reviewed revision"
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

  app.openapi(approveDeveloperRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { id } = c.req.valid("param");
    const { expected_revision } = c.req.valid("json");
    const db = new DevelopersDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.approve(
      id,
      expected_revision,
      auth.userId
    );
    if (error || !data) {
      const status = statusFromErrorCode(error?.code);
      return c.json(
        {
          error: {
            message: error?.message ?? "Unable to approve developer",
            code: error?.code ?? "DATABASE_ERROR"
          }
        },
        status
      );
    }
    return c.json({ result: data }, 200);
  });

  const developerHistoryRoute = createRoute({
    method: "get",
    path: "/developers/{id}/history",
    tags: ["Moderation"],
    summary: "List the write history of a developer profile",
    security: [{ Bearer: [] }],
    middleware: [
      dependencies.requireAuth(),
      dependencies.requireModerator()
    ] as const,
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
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
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

  app.openapi(developerHistoryRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = new DevelopersDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.listHistory(id);
    if (error || !data) {
      return c.json(
        {
          error: {
            message: error?.message ?? "Unable to load developer history",
            code: error?.code ?? "DATABASE_ERROR"
          }
        },
        500
      );
    }
    return c.json({ result: data }, 200);
  });
}
