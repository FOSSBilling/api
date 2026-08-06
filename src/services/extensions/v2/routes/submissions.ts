import { errorBody } from "./errors";
import { requireActiveAuth } from "../middleware";
import { getExtensionsDb } from "../../../../lib/db";
import { getAuth } from "../../../../lib/auth";
import { createRoute, z } from "@hono/zod-openapi";
import {
  ActiveAccountRequiredResponse,
  PaginationSchema,
  errorResponse
} from "../schemas/common";
import {
  SubmissionPayloadSchema,
  SubmissionPageQuerySchema,
  SubmissionSchema
} from "../schemas/submissions";
import { SubmissionsDatabase } from "../db/submissions";
import { ExtensionsV2App } from "./app";

export function registerSubmissionRoutes(app: ExtensionsV2App): void {
  const createSubmissionRoute = createRoute({
    method: "post",
    path: "/submissions",
    tags: ["Submissions"],
    summary: "Submit a new extension, or an edit to one you own",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
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
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller does not own the target developer or extension"
      },
      409: errorResponse(
        "Ownership or target changed, a duplicate is pending, or the pending limit was reached"
      ),
      422: errorResponse("Payload failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(createSubmissionRoute, async (c) => {
    const auth = getAuth(c);
    const payload = c.req.valid("json");
    const db = new SubmissionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const ownership = await db.resolveOwnership(payload, auth.userId);
    if (ownership.error || !ownership.data) {
      return c.json(
        errorBody(ownership.error, "Unable to validate ownership"),
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
        errorBody(created.error, "Unable to create submission"),
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
    middleware: [requireActiveAuth()] as const,
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
      401: errorResponse("Missing or invalid bearer token"),
      403: ActiveAccountRequiredResponse,
      422: errorResponse("Pagination query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(mineRoute, async (c) => {
    const auth = getAuth(c);
    const { limit, cursor } = c.req.valid("query");
    const db = new SubmissionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const { data, error } = await db.listBySubmitter(
      auth.userId,
      limit,
      cursor
    );
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to load submissions"),
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
