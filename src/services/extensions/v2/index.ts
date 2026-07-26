import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { MiddlewareHandler } from "hono";
import { Scalar } from "@scalar/hono-api-reference";
import { getPlatform } from "../../../lib/middleware";
import { getAuth, requireAuth } from "../../../lib/auth";
import {
  ClaimNoteSchema,
  DeveloperClaimSchema,
  DeveloperHistoryEntrySchema,
  DeveloperProfileSchema,
  DeveloperSchema,
  DeveloperTransferSchema,
  ErrorResponseSchema,
  IdParamSchema,
  PendingDeveloperClaimSchema,
  QueueQuerySchema,
  ReviewNoteOptionalSchema,
  ReviewNoteRequiredSchema,
  SubmissionPayloadSchema,
  SubmissionSchema,
  TokenParamSchema
} from "./interfaces";
import { DevelopersDatabase } from "./developers-database";
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
      description: "Caller does not own the target developer or extension"
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
    developerId: ownership.data.developerId,
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
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Developer id already taken by someone else, or id was changed on an existing profile"
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

extensionsV2.openapi(upsertOwnDeveloperRoute, async (c) => {
  const auth = getAuth(c);
  const body = c.req.valid("json");
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Profile is already owned, caller already owns a different profile, or already has a pending claim on this one"
    },
    422: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "id param or note body failed validation"
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
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

  const { data, error } = await db.claim(id, auth.userId, note);
  if (error || !data) {
    return c.json(
      {
        error: {
          message: error?.message ?? "Unable to create claim",
          code: error?.code ?? "DATABASE_ERROR"
        }
      },
      statusFromErrorCode(error?.code)
    );
  }

  return c.json({ result: data }, 201);
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
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
  path: "/developers/transfers/{token}/accept",
  tags: ["Developers"],
  summary: "Accept a developer profile transfer using its single-use token",
  security: [{ Bearer: [] }],
  middleware: [requireAuth()] as const,
  request: { params: TokenParamSchema },
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
      description: "token param failed validation"
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Database error"
    }
  }
});

extensionsV2.openapi(acceptTransferRoute, async (c) => {
  const auth = getAuth(c);
  const { token } = c.req.valid("param");
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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

extensionsV2.openapi(approveDeveloperRoute, async (c) => {
  const { id } = c.req.valid("param");
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

  const { data, error } = await db.approve(id);
  if (error || !data) {
    const status = error?.code === "NOT_FOUND" ? 404 : 500;
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
  const platform = getPlatform(c);
  const db = new DevelopersDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
