import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { MiddlewareHandler } from "hono";
import { Scalar } from "@scalar/hono-api-reference";
import { getPlatform } from "../../../lib/middleware";
import { getAuth, requireAuth } from "../../../lib/auth";
import {
  AuthorHistoryEntrySchema,
  AuthorProfileSchema,
  AuthorSchema,
  ErrorResponseSchema,
  IdParamSchema,
  QueueQuerySchema,
  ReviewNoteOptionalSchema,
  ReviewNoteRequiredSchema,
  SubmissionPayloadSchema,
  SubmissionSchema
} from "./interfaces";
import { AuthorsDatabase } from "./authors-database";
import { SubmissionsDatabase } from "./submissions-database";
import { UsersDatabase } from "./users-database";

const extensionsV2 = new OpenAPIHono<{ Bindings: CloudflareBindings }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            message: "Invalid request",
            code: "VALIDATION_ERROR",
            details: result.error.issues
          }
        },
        422
      );
    }
  }
});

extensionsV2.use("/*", cors({ origin: "*" }));
extensionsV2.use("/*", trimTrailingSlash());

extensionsV2.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer"
});

function statusFromErrorCode(code?: string): 404 | 409 | 500 {
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  return 500;
}

function requireModerator(): MiddlewareHandler {
  return async (c, next) => {
    const auth = getAuth(c);
    const platform = getPlatform(c);
    const users = new UsersDatabase(platform.getDatabase("DB_EXTENSIONS"));

    const { data: isModerator, error } = await users.isModerator(auth.userId);
    if (error) {
      return c.json(
        { error: { message: error.message, code: error.code } },
        500
      );
    }
    if (!isModerator) {
      return c.json(
        { error: { message: "Moderator access required", code: "FORBIDDEN" } },
        403
      );
    }

    await next();
  };
}

const createSubmissionRoute = createRoute({
  method: "post",
  path: "/submissions",
  tags: ["Submissions"],
  summary: "Submit a new extension, or an edit to one you own",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
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
      description: "Caller does not own the target author or extension"
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

extensionsV2.openapi(createSubmissionRoute, async (c) => {
  const auth = getAuth(c);
  const payload = c.req.valid("json");
  const platform = getPlatform(c);
  const db = new SubmissionsDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
    authorId: ownership.data.authorId,
    submittedBy: auth.userId,
    payload
  });
  if (created.error || !created.data) {
    return c.json(
      {
        error: {
          message: created.error?.message ?? "Unable to create submission",
          code: "DATABASE_ERROR"
        }
      },
      500
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
  middleware: [requireAuth()] as const,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: z.array(SubmissionSchema) })
        }
      },
      description: "The caller's submissions"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(mineRoute, async (c) => {
  const auth = getAuth(c);
  const platform = getPlatform(c);
  const db = new SubmissionsDatabase(platform.getDatabase("DB_EXTENSIONS"));

  const { data, error } = await db.listBySubmitter(auth.userId);
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to load submissions",
          code: "DATABASE_ERROR"
        }
      },
      500
    );
  }

  return c.json({ result: data }, 200);
});

const queueRoute = createRoute({
  method: "get",
  path: "/submissions/queue",
  tags: ["Moderation"],
  summary: "List submissions in the moderation queue",
  security: [{ Bearer: [] }],
  middleware: [requireAuth(), requireModerator()] as const,
  request: { query: QueueQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: z.array(SubmissionSchema) })
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not a moderator"
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

extensionsV2.openapi(queueRoute, async (c) => {
  const platform = getPlatform(c);
  const db = new SubmissionsDatabase(platform.getDatabase("DB_EXTENSIONS"));

  const { status } = c.req.valid("query");

  const { data, error } = await db.listQueue(status ?? "pending");
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to load queue",
          code: "DATABASE_ERROR"
        }
      },
      500
    );
  }

  return c.json({ result: data }, 200);
});

const approveRoute = createRoute({
  method: "post",
  path: "/submissions/{id}/approve",
  tags: ["Moderation"],
  summary: "Approve a pending submission",
  security: [{ Bearer: [] }],
  middleware: [requireAuth(), requireModerator()] as const,
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
            result: z.object({ id: z.string(), status: z.literal("approved") })
          })
        }
      },
      description:
        "Submission approved and written through to the live extension/author"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not a moderator"
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

extensionsV2.openapi(approveRoute, async (c) => {
  const auth = getAuth(c);
  const { id } = c.req.valid("param");
  const { review_note } = c.req.valid("json");
  const platform = getPlatform(c);
  const db = new SubmissionsDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
  middleware: [requireAuth(), requireModerator()] as const,
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
            result: z.object({ id: z.string(), status: z.literal("rejected") })
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not a moderator"
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

extensionsV2.openapi(rejectRoute, async (c) => {
  const auth = getAuth(c);
  const { id } = c.req.valid("param");
  const { review_note } = c.req.valid("json");
  const platform = getPlatform(c);
  const db = new SubmissionsDatabase(platform.getDatabase("DB_EXTENSIONS"));

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

const upsertOwnAuthorRoute = createRoute({
  method: "put",
  path: "/authors/me",
  tags: ["Authors"],
  summary: "Create or update the caller's own developer profile",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  request: {
    body: {
      content: { "application/json": { schema: AuthorSchema } }
    }
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: AuthorProfileSchema })
        }
      },
      description: "Developer profile created or updated and usable immediately"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Author id already taken by someone else, or id was changed on an existing profile"
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

extensionsV2.openapi(upsertOwnAuthorRoute, async (c) => {
  const auth = getAuth(c);
  const body = c.req.valid("json");
  const platform = getPlatform(c);
  const db = new AuthorsDatabase(platform.getDatabase("DB_EXTENSIONS"));

  const { data, error } = await db.upsertOwn(auth.userId, body);
  if (error || !data) {
    const status = error?.code === "CONFLICT" ? 409 : 500;
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to save developer profile",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      status
    );
  }

  return c.json({ result: data }, 200);
});

const unapprovedAuthorsRoute = createRoute({
  method: "get",
  path: "/authors/unapproved",
  tags: ["Moderation"],
  summary: "List developer profiles awaiting moderator review",
  security: [{ Bearer: [] }],
  middleware: [requireAuth(), requireModerator()] as const,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: z.array(AuthorProfileSchema) })
        }
      },
      description: "Developer profiles not yet approved"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not a moderator"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(unapprovedAuthorsRoute, async (c) => {
  const platform = getPlatform(c);
  const db = new AuthorsDatabase(platform.getDatabase("DB_EXTENSIONS"));

  const { data, error } = await db.listUnapproved();
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to load unapproved authors",
          code: "DATABASE_ERROR"
        }
      },
      500
    );
  }

  return c.json({ result: data }, 200);
});

const approveAuthorRoute = createRoute({
  method: "post",
  path: "/authors/{id}/approve",
  tags: ["Moderation"],
  summary: "Mark a developer profile as reviewed/approved",
  security: [{ Bearer: [] }],
  middleware: [requireAuth(), requireModerator()] as const,
  request: { params: IdParamSchema },
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not a moderator"
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No author with that id"
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

extensionsV2.openapi(approveAuthorRoute, async (c) => {
  const { id } = c.req.valid("param");
  const platform = getPlatform(c);
  const db = new AuthorsDatabase(platform.getDatabase("DB_EXTENSIONS"));

  const { data, error } = await db.approve(id);
  if (error || !data) {
    const status = error?.code === "NOT_FOUND" ? 404 : 500;
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to approve author",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      status
    );
  }

  return c.json({ result: data }, 200);
});

const authorHistoryRoute = createRoute({
  method: "get",
  path: "/authors/{id}/history",
  tags: ["Moderation"],
  summary: "List the write history of a developer profile",
  security: [{ Bearer: [] }],
  middleware: [requireAuth(), requireModerator()] as const,
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: z.array(AuthorHistoryEntrySchema) })
        }
      },
      description: "Snapshots of the profile, newest first"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not a moderator"
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

extensionsV2.openapi(authorHistoryRoute, async (c) => {
  const { id } = c.req.valid("param");
  const platform = getPlatform(c);
  const db = new AuthorsDatabase(platform.getDatabase("DB_EXTENSIONS"));

  const { data, error } = await db.listHistory(id);
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to load author history",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      500
    );
  }

  return c.json({ result: data }, 200);
});

extensionsV2.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "FOSSBilling Extensions API (v2)",
    version: "2.0.0",
    description:
      "Self-service extension submission, ownership, and moderation. Read-only listings remain at /extensions/v1."
  },
  servers: [{ url: "/extensions/v2" }]
});

extensionsV2.get(
  "/docs",
  Scalar({
    url: "/extensions/v2/openapi.json",
    pageTitle: "FOSSBilling Extensions API (v2)"
  })
);

export default extensionsV2;
