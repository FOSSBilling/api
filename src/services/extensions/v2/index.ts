import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { MiddlewareHandler } from "hono";
import { Scalar } from "@scalar/hono-api-reference";
import { getPlatform } from "../../../lib/middleware";
import { getAuth, requireAuth } from "../../../lib/auth";
import { getExtensionsDb } from "../../../lib/db";
import {
  ClaimNoteSchema,
  DeveloperClaimSchema,
  DeveloperApprovalSchema,
  DeveloperHistoryEntrySchema,
  DeveloperProfileSchema,
  DeveloperSchema,
  DeveloperTransferSchema,
  ErrorResponseSchema,
  ExtensionListQuerySchema,
  ExtensionListResponseSchema,
  ExtensionSchema,
  IdParamSchema,
  PendingDeveloperClaimSchema,
  PaginationSchema,
  PublicDeveloperSchema,
  QueueQuerySchema,
  ReverifyQuerySchema,
  ReviewNoteOptionalSchema,
  ReviewNoteRequiredSchema,
  SubmissionPayloadSchema,
  SubmissionPageQuerySchema,
  SubmissionSchema,
  TransferAcceptanceSchema,
  toPublicDeveloper
} from "./interfaces";
import { DevelopersDatabase } from "./developers-database";
import { ExtensionsDatabase } from "./extensions-database";
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

function statusFromGithubErrorCode<T extends number>(
  code: string | undefined,
  fallback: T
): T | 422 | 429 | 503 {
  if (code === "GITHUB_ENTITY_UNSUPPORTED") return 422;
  if (code === "RATE_LIMITED") return 429;
  if (code === "SERVICE_UNAVAILABLE") return 503;
  return fallback;
}

function requireModerator(): MiddlewareHandler {
  return async (c, next) => {
    const auth = getAuth(c);
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

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

const listExtensionsRoute = createRoute({
  method: "get",
  path: "/extensions",
  tags: ["Extensions"],
  summary: "List published extensions",
  request: { query: ExtensionListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ExtensionListResponseSchema
        }
      },
      description: "Extensions matching the given filters"
    },
    422: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Filter or pagination query failed validation"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(listExtensionsRoute, async (c) => {
  const { type, developer_id, limit, cursor } = c.req.valid("query");
  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.list({
    type,
    developerId: developer_id,
    limit,
    cursor
  });
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to load extensions",
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

const getExtensionRoute = createRoute({
  method: "get",
  path: "/extensions/{id}",
  tags: ["Extensions"],
  summary: "Get a single published extension",
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ result: ExtensionSchema }) }
      },
      description: "The extension"
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No extension with that id"
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

extensionsV2.openapi(getExtensionRoute, async (c) => {
  const { id } = c.req.valid("param");
  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.getById(id);
  if (error || !data) {
    const status = error?.code === "NOT_FOUND" ? 404 : 500;
    return c.json(
      {
        error: {
          message: error?.message ?? "Extension not found",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      status
    );
  }

  return c.json({ result: data }, 200);
});

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

extensionsV2.openapi(createSubmissionRoute, async (c) => {
  const auth = getAuth(c);
  const payload = c.req.valid("json");
  const db = new SubmissionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

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
  middleware: [requireAuth()] as const,
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

extensionsV2.openapi(mineRoute, async (c) => {
  const auth = getAuth(c);
  const { limit, cursor } = c.req.valid("query");
  const db = new SubmissionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.listBySubmitter(auth.userId, limit, cursor);
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to load submissions",
          code: "DATABASE_ERROR"
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
  const db = new SubmissionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

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
          code: "DATABASE_ERROR"
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
        "Submission approved and written through to the live extension/developer"
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
  const db = new SubmissionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

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
  const db = new SubmissionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

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

const upsertOwnDeveloperRoute = createRoute({
  method: "put",
  path: "/developers/me",
  tags: ["Developers"],
  summary: "Create or update the caller's own developer profile",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  request: {
    body: {
      content: { "application/json": { schema: DeveloperSchema } }
    }
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: DeveloperProfileSchema })
        }
      },
      description: "Developer profile created or updated and usable immediately"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "This id matches a real GitHub organization or username that isn't linked to the caller's account"
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Developer id already taken by someone else, or id was changed on an existing profile"
    },
    429: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "GitHub verification is temporarily rate limited"
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "GitHub verification is temporarily unavailable"
    },
    422: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Payload failed validation, or the GitHub account type is unsupported"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(upsertOwnDeveloperRoute, async (c) => {
  const auth = getAuth(c);
  const body = c.req.valid("json");
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.upsertOwn(
    auth.userId,
    body,
    platform.getEnv("GITHUB_TOKEN")
  );
  if (error || !data) {
    const status =
      error?.code === "GITHUB_MISMATCH"
        ? 403
        : error?.code === "CONFLICT" || error?.code === "DEVELOPER_ID_TAKEN"
          ? 409
          : statusFromGithubErrorCode(error?.code, 500);
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

const deleteOwnDeveloperRoute = createRoute({
  method: "delete",
  path: "/developers/me",
  tags: ["Developers"],
  summary: "Permanently delete the caller's own developer profile",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            result: z.object({ id: z.string(), deleted: z.literal(true) })
          })
        }
      },
      description: "Profile deleted"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller has no developer profile"
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Profile still has published extensions, or has a pending submission awaiting review"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(deleteOwnDeveloperRoute, async (c) => {
  const auth = getAuth(c);
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.deleteOwn(auth.userId);
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to delete developer profile",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      statusFromErrorCode(error?.code)
    );
  }

  return c.json({ result: data }, 200);
});

const reverifyOwnDeveloperRoute = createRoute({
  method: "post",
  path: "/developers/me/reverify",
  tags: ["Developers"],
  summary:
    "Re-check the caller's linked GitHub identity against their own developer profile",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  request: { query: ReverifyQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: DeveloperProfileSchema })
        }
      },
      description: "Verification re-checked (result may be verified or not)"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller has no developer profile"
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Developer ownership changed while re-verifying"
    },
    429: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "check_url was used again too soon, or GitHub verification is rate limited"
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "GitHub verification is temporarily unavailable"
    },
    422: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "The GitHub account type is unsupported"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(reverifyOwnDeveloperRoute, async (c) => {
  const auth = getAuth(c);
  const { check_url } = c.req.valid("query");
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.reverifyOwn(
    auth.userId,
    check_url,
    platform.getEnv("GITHUB_TOKEN")
  );
  if (error || !data) {
    const status = statusFromGithubErrorCode(
      error?.code,
      statusFromErrorCode(error?.code)
    );
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to re-verify developer profile",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      status
    );
  }

  return c.json({ result: data }, 200);
});

function statusFromOwnershipErrorCode(code?: string): 403 | 404 | 500 {
  if (code === "NOT_FOUND") return 404;
  if (code === "FORBIDDEN") return 403;
  return 500;
}

const claimDeveloperRoute = createRoute({
  method: "post",
  path: "/developers/{id}/claim",
  tags: ["Developers"],
  summary: "Request ownership of an unowned developer profile",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  request: {
    params: IdParamSchema,
    body: {
      content: { "application/json": { schema: ClaimNoteSchema } }
    }
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({ result: DeveloperClaimSchema })
        }
      },
      description: "Claim created and pending moderator review"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No developer with that id"
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Caller's linked GitHub account doesn't match this developer's GitHub organization or username"
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Profile is already owned, caller already owns a different profile, or already has a pending claim on this one"
    },
    429: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "GitHub verification is temporarily rate limited"
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "GitHub verification is temporarily unavailable"
    },
    422: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "The request failed validation, or the GitHub account type is unsupported"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(claimDeveloperRoute, async (c) => {
  const auth = getAuth(c);
  const { id } = c.req.valid("param");
  const { note } = c.req.valid("json");
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.claim(
    id,
    auth.userId,
    note,
    platform.getEnv("GITHUB_TOKEN")
  );
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to create claim",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      error?.code === "GITHUB_MISMATCH"
        ? 403
        : statusFromGithubErrorCode(
            error?.code,
            statusFromErrorCode(error?.code)
          )
    );
  }

  return c.json({ result: data }, 201);
});

const cancelClaimRoute = createRoute({
  method: "post",
  path: "/developers/claims/{id}/cancel",
  tags: ["Developers"],
  summary: "Withdraw the caller's own pending profile claim",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            result: z.object({ id: z.string(), cancelled: z.literal(true) })
          })
        }
      },
      description: "Claim withdrawn"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No pending claim with that id owned by the caller"
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

extensionsV2.openapi(cancelClaimRoute, async (c) => {
  const auth = getAuth(c);
  const { id } = c.req.valid("param");
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.cancelClaim(id, auth.userId);
  if (error || !data) {
    const status = error?.code === "NOT_FOUND" ? 404 : 500;
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to cancel claim",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      status
    );
  }

  return c.json({ result: { id: data.id, cancelled: true as const } }, 200);
});

const myClaimsRoute = createRoute({
  method: "get",
  path: "/developers/claims/mine",
  tags: ["Developers"],
  summary: "List the caller's own profile claims, in any status",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: z.array(DeveloperClaimSchema) })
        }
      },
      description: "The caller's claims"
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

extensionsV2.openapi(myClaimsRoute, async (c) => {
  const auth = getAuth(c);
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.listMyClaims(auth.userId);
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to load claims",
          code: "DATABASE_ERROR"
        }
      },
      500
    );
  }

  return c.json({ result: data }, 200);
});

const pendingClaimsRoute = createRoute({
  method: "get",
  path: "/developers/claims",
  tags: ["Moderation"],
  summary: "List pending profile claims",
  security: [{ Bearer: [] }],
  middleware: [requireAuth(), requireModerator()] as const,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: z.array(PendingDeveloperClaimSchema) })
        }
      },
      description: "Claims awaiting moderator review"
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

extensionsV2.openapi(pendingClaimsRoute, async (c) => {
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.listPendingClaims();
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to load pending claims",
          code: "DATABASE_ERROR"
        }
      },
      500
    );
  }

  return c.json({ result: data }, 200);
});

const approveClaimRoute = createRoute({
  method: "post",
  path: "/developers/claims/{id}/approve",
  tags: ["Moderation"],
  summary: "Approve a pending profile claim",
  security: [{ Bearer: [] }],
  middleware: [requireAuth(), requireModerator()] as const,
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: DeveloperProfileSchema })
        }
      },
      description:
        "Claim approved; profile ownership transferred to the claimant"
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
      description: "No claim or developer with that id"
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Claim is no longer pending, profile is no longer unowned, or the claimant now owns a different profile"
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

extensionsV2.openapi(approveClaimRoute, async (c) => {
  const auth = getAuth(c);
  const { id } = c.req.valid("param");
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.approveClaim(id, auth.userId);
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to approve claim",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      statusFromErrorCode(error?.code)
    );
  }

  return c.json({ result: data }, 200);
});

const rejectClaimRoute = createRoute({
  method: "post",
  path: "/developers/claims/{id}/reject",
  tags: ["Moderation"],
  summary: "Reject a pending profile claim",
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
          schema: z.object({ result: DeveloperClaimSchema })
        }
      },
      description: "Claim rejected"
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
      description: "No pending claim with that id"
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

extensionsV2.openapi(rejectClaimRoute, async (c) => {
  const auth = getAuth(c);
  const { id } = c.req.valid("param");
  const { review_note } = c.req.valid("json");
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.rejectClaim(id, auth.userId, review_note);
  if (error || !data) {
    const status = error?.code === "NOT_FOUND" ? 404 : 500;
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to reject claim",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      status
    );
  }

  return c.json({ result: data }, 200);
});

const initiateTransferRoute = createRoute({
  method: "post",
  path: "/developers/{id}/transfer",
  tags: ["Developers"],
  summary: "Create a single-use link to hand this profile to another account",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: DeveloperTransferSchema })
        }
      },
      description:
        "Transfer token created; share it out-of-band with the recipient"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller does not own this profile"
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No developer with that id"
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

extensionsV2.openapi(initiateTransferRoute, async (c) => {
  const auth = getAuth(c);
  const { id } = c.req.valid("param");
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.initiateTransfer(id, auth.userId);
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to create transfer",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      statusFromOwnershipErrorCode(error?.code)
    );
  }

  return c.json({ result: data }, 200);
});

const revokeTransferRoute = createRoute({
  method: "post",
  path: "/developers/{id}/transfer/revoke",
  tags: ["Developers"],
  summary: "Revoke this profile's pending transfer link, if any",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            result: z.object({ id: z.string(), revoked: z.literal(true) })
          })
        }
      },
      description: "Any pending transfer for this profile is revoked"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller does not own this profile"
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No developer with that id"
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

extensionsV2.openapi(revokeTransferRoute, async (c) => {
  const auth = getAuth(c);
  const { id } = c.req.valid("param");
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.revokeTransfer(id, auth.userId);
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to revoke transfer",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      statusFromOwnershipErrorCode(error?.code)
    );
  }

  return c.json({ result: data }, 200);
});

const acceptTransferRoute = createRoute({
  method: "post",
  path: "/developers/transfers/accept",
  tags: ["Developers"],
  summary: "Accept a developer profile transfer using its single-use token",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  request: {
    body: {
      content: { "application/json": { schema: TransferAcceptanceSchema } }
    }
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: DeveloperProfileSchema })
        }
      },
      description: "Profile is now owned by the caller"
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Missing or invalid bearer token"
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Transfer link is invalid, already used, or expired"
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller already owns a different developer profile"
    },
    422: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "token body failed validation"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(acceptTransferRoute, async (c) => {
  const auth = getAuth(c);
  const { token } = c.req.valid("json");
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.acceptTransfer(token, auth.userId);
  if (error || !data) {
    const status = statusFromErrorCode(error?.code);
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to accept transfer",
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
  middleware: [requireAuth(), requireModerator()] as const,
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not a moderator"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(allDevelopersRoute, async (c) => {
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

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
  middleware: [requireAuth(), requireModerator()] as const,
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not a moderator"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(unapprovedDevelopersRoute, async (c) => {
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

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

// Registered after every other static-segment GET /developers/* route
// (claims, claims/mine, unapproved above) — Hono matches path params against
// whichever handler was registered first among overlapping patterns, so this
// wildcard would otherwise shadow those static routes (e.g. swallow
// GET /developers/claims as a lookup for a developer literally named
// "claims").
const getDeveloperRoute = createRoute({
  method: "get",
  path: "/developers/{id}",
  tags: ["Developers"],
  summary: "Get a developer's public profile",
  request: { params: IdParamSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ result: PublicDeveloperSchema })
        }
      },
      description: "The developer's public profile"
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "No developer with that id"
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

extensionsV2.openapi(getDeveloperRoute, async (c) => {
  const { id } = c.req.valid("param");
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.getById(id);
  if (error || !data) {
    const status = error?.code === "NOT_FOUND" ? 404 : 500;
    return c.json(
      {
        error: {
          message: error?.message ?? "Developer not found",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      status
    );
  }

  return c.json({ result: toPublicDeveloper(data) }, 200);
});

const approveDeveloperRoute = createRoute({
  method: "post",
  path: "/developers/{id}/approve",
  tags: ["Moderation"],
  summary: "Mark a developer profile as reviewed/approved",
  security: [{ Bearer: [] }],
  middleware: [requireAuth(), requireModerator()] as const,
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
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Caller is not a moderator"
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

extensionsV2.openapi(approveDeveloperRoute, async (c) => {
  const auth = getAuth(c);
  const { id } = c.req.valid("param");
  const { expected_revision } = c.req.valid("json");
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.approve(id, expected_revision, auth.userId);
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
  middleware: [requireAuth(), requireModerator()] as const,
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

extensionsV2.openapi(developerHistoryRoute, async (c) => {
  const { id } = c.req.valid("param");
  const db = new DevelopersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

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

extensionsV2.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "FOSSBilling Extensions API (v2)",
    version: "2.0.0",
    description:
      "Self-service extension submission, ownership, moderation, and public browsing. v1 (/extensions/v1) remains available for existing integrations."
  },
  servers: [{ url: "/extensions/v2" }]
});

extensionsV2.get(
  "/docs",
  Scalar({
    url: "/extensions/v2/openapi.json",
    pageTitle: "FOSSBilling Extensions API (v2)",
    agent: {
      disabled: true
    },
    documentDownloadType: "none",
    hideClientButton: true,
    hideModels: true,
    hiddenClients: {
      c: true,
      clojure: true,
      csharp: true,
      dart: true,
      fsharp: true,
      go: true,
      java: true,
      js: ["axios", "jquery", "ofetch"],
      kotlin: true,
      node: ["axios", "ofetch", "undici"],
      objc: true,
      ocaml: true,
      php: ["guzzle", "laravel"],
      powershell: true,
      python: true,
      r: true,
      ruby: true,
      rust: true,
      shell: ["httpie"],
      swift: true
    },
    telemetry: false
  })
);

export default extensionsV2;
