import { createRoute, z } from "@hono/zod-openapi";
import {
  statusFromErrorCode,
  statusFromGithubErrorCode,
  statusFromOwnershipErrorCode
} from "./route-errors";
import {
  ActiveAccountRequiredResponse,
  ClaimNoteSchema,
  DeveloperClaimSchema,
  DeveloperProfileSchema,
  DeveloperTransferSchema,
  ErrorResponseSchema,
  IdParamSchema,
  PendingDeveloperClaimSchema,
  ReviewNoteRequiredSchema,
  TransferAcceptanceSchema
} from "./interfaces";
import { DeveloperClaimsDatabase } from "./developer-claims-database";
import { DeveloperTransfersDatabase } from "./developer-transfers-database";
import { ExtensionsV2App, RouteDependencies } from "./route-dependencies";

export function registerOwnershipRoutes(
  app: ExtensionsV2App,
  dependencies: RouteDependencies
): void {
  const claimDeveloperRoute = createRoute({
    method: "post",
    path: "/developers/{id}/claim",
    tags: ["Developers"],
    summary: "Request ownership of an unowned developer profile",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireAuth()] as const,
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
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or the caller's linked GitHub account doesn't match this developer's GitHub organization or username"
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

  app.openapi(claimDeveloperRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { id } = c.req.valid("param");
    const { note } = c.req.valid("json");
    const platform = dependencies.platform(c);
    const db = new DeveloperClaimsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
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
        error?.code === "GITHUB_MISMATCH" || error?.code === "ACCOUNT_INACTIVE"
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
    middleware: [dependencies.requireAuth()] as const,
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
      403: ActiveAccountRequiredResponse,
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

  app.openapi(cancelClaimRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { id } = c.req.valid("param");
    const db = new DeveloperClaimsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.cancelClaim(id, auth.userId);
    if (error || !data) {
      const status = statusFromErrorCode(error?.code, false);
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
    middleware: [dependencies.requireAuth()] as const,
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
      403: ActiveAccountRequiredResponse,
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(myClaimsRoute, async (c) => {
    const auth = dependencies.auth(c);
    const db = new DeveloperClaimsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
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
    middleware: [
      dependencies.requireAuth(),
      dependencies.requireModerator()
    ] as const,
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
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(pendingClaimsRoute, async (c) => {
    const db = new DeveloperClaimsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
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
    middleware: [
      dependencies.requireAuth(),
      dependencies.requireModerator()
    ] as const,
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
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
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

  app.openapi(approveClaimRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { id } = c.req.valid("param");
    const db = new DeveloperClaimsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
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
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
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

  app.openapi(rejectClaimRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { id } = c.req.valid("param");
    const { review_note } = c.req.valid("json");
    const db = new DeveloperClaimsDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.rejectClaim(id, auth.userId, review_note);
    if (error || !data) {
      const status = statusFromErrorCode(error?.code, false);
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
    middleware: [dependencies.requireAuth()] as const,
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
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive or the caller does not own this profile"
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

  app.openapi(initiateTransferRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { id } = c.req.valid("param");
    const db = new DeveloperTransfersDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
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
    middleware: [dependencies.requireAuth()] as const,
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
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive or the caller does not own this profile"
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

  app.openapi(revokeTransferRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { id } = c.req.valid("param");
    const db = new DeveloperTransfersDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
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
    middleware: [dependencies.requireAuth()] as const,
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
      403: ActiveAccountRequiredResponse,
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

  app.openapi(acceptTransferRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { token } = c.req.valid("json");
    const db = new DeveloperTransfersDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
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
}
