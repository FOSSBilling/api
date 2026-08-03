import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorResponseSchema,
  PaginationSchema,
  SubmissionPayloadSchema,
  SubmissionPageQuerySchema,
  SubmissionSchema
} from "./interfaces";
import { SubmissionsDatabase } from "./submissions-database";
import { ExtensionsV2App, RouteDependencies } from "./route-dependencies";

export function registerSubmissionRoutes(
  app: ExtensionsV2App,
  dependencies: RouteDependencies
): void {
  const createSubmissionRoute = createRoute({
    method: "post",
    path: "/submissions",
    tags: ["Submissions"],
    summary: "Submit a new extension, or an edit to one you own",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireAuth()] as const,
    request: {
      body: {
        content: { "application/json": { schema: SubmissionPayloadSchema } }
      }
    },
    responses: {
      201: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({ id: z.string(), status: z.literal("pending") })
            })
          }
        },
        description: "Submission created and pending moderator review"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Caller does not own the target developer or extension"
      },
      409: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description:
          "Ownership or target changed, a duplicate is pending, or the pending limit was reached"
      },
      422: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Payload failed validation"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(createSubmissionRoute, async (c) => {
    const auth = dependencies.auth(c);
    const payload = c.req.valid("json");
    const db = new SubmissionsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const ownership = await db.resolveOwnership(payload, auth.userId);
    if (ownership.error || !ownership.data) {
      return c.json(
        {
          error: {
            message: ownership.error?.message ?? "Unable to validate ownership",
            code: ownership.error?.code ?? "DATABASE_ERROR"
          }
        },
        ownership.error?.code === "FORBIDDEN" ? 403 : 500
      );
    }
    const created = await db.create({
      extensionId: ownership.data.extensionId,
      developerId: ownership.data.developerId,
      ownershipEpoch: ownership.data.ownershipEpoch,
      submittedBy: auth.userId,
      payload
    });
    if (created.error || !created.data) {
      return c.json(
        {
          error: {
            message: created.error?.message ?? "Unable to create submission",
            code: created.error?.code ?? "DATABASE_ERROR"
          }
        },
        created.error?.code === "CONFLICT" ? 409 : 500
      );
    }
    return c.json(
      { result: { id: created.data.id, status: "pending" as const } },
      201
    );
  });

  const mineRoute = createRoute({
    method: "get",
    path: "/submissions/mine",
    tags: ["Submissions"],
    summary: "List the caller's own submissions, in any status",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireAuth()] as const,
    request: { query: SubmissionPageQuerySchema },
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
        description: "The caller's submissions"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
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

  app.openapi(mineRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { limit, cursor } = c.req.valid("query");
    const db = new SubmissionsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.listBySubmitter(
      auth.userId,
      limit,
      cursor
    );
    if (error || !data) {
      return c.json(
        {
          error: {
            message: error?.message ?? "Unable to load submissions",
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
