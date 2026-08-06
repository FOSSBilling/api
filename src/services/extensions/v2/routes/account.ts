import { createRoute, z } from "@hono/zod-openapi";
import { getAuth } from "../../../../lib/auth";
import { statusFromErrorCode } from "./errors";
import {
  ActiveAccountRequiredResponse,
  ErrorResponseSchema
} from "../schemas/common";
import {
  UserIdentityInputSchema,
  UserProfileUpdateSchema,
  UserSchema
} from "../schemas/users";
import { UsersDatabase } from "../db/users";
import { ExtensionsV2App, RouteDependencies } from "./dependencies";

function toUserResponse(user: {
  displayName: string | null;
  isModerator: boolean;
  githubLinked: boolean;
  deletedAt: string | null;
}) {
  return {
    display_name: user.displayName,
    is_moderator: user.isModerator,
    github_linked: user.githubLinked,
    active: user.deletedAt === null
  };
}

export function registerAccountRoutes(
  app: ExtensionsV2App,
  dependencies: RouteDependencies
): void {
  const syncIdentityRoute = createRoute({
    method: "put",
    path: "/users/me/identity",
    tags: ["Users"],
    summary: "Synchronize the caller's OIDC identity projection",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireIdentitySync()] as const,
    request: {
      body: {
        content: { "application/json": { schema: UserIdentityInputSchema } }
      }
    },
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ result: UserSchema }) }
        },
        description: "Identity projection synchronized"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: {
        ...ActiveAccountRequiredResponse,
        description: "Identity synchronization requires a trusted assertion"
      },
      422: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Identity payload failed validation"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(syncIdentityRoute, async (c) => {
    // requireIdentitySync has already verified the HMAC assertion minted by
    // the trusted Extensions site. The projection fields below therefore
    // represent the site's OIDC callback, while authorization state remains
    // API-owned and is never accepted from the request body.
    const auth = getAuth(c);
    const body = c.req.valid("json");
    const users = new UsersDatabase(dependencies.database(c.env.DB_EXTENSIONS));
    const result = await users.syncIdentity(auth.userId, {
      name: body.name,
      email: body.email,
      emailVerified: body.email_verified,
      picture: body.picture,
      githubLogin: body.github_login,
      githubOrgs: body.github_orgs,
      githubOrgsExpiresAt: body.github_orgs_expires_at
    });
    if (result.error || !result.data) {
      return c.json(
        {
          error: {
            message: result.error?.message ?? "Unable to sync identity",
            code: result.error?.code ?? "DATABASE_ERROR"
          }
        },
        500
      );
    }
    return c.json({ result: toUserResponse(result.data) }, 200);
  });

  const getUserRoute = createRoute({
    method: "get",
    path: "/users/me",
    tags: ["Users"],
    summary: "Get the caller's account projection",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireAuthAllowInactive()] as const,
    responses: {
      200: {
        content: {
          "application/json": { schema: z.object({ result: UserSchema }) }
        },
        description: "The caller's account projection, including active status"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      404: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Account does not exist"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(getUserRoute, async (c) => {
    const auth = getAuth(c);
    const users = new UsersDatabase(dependencies.database(c.env.DB_EXTENSIONS));
    const result = await users.get(auth.userId);
    if (result.error && result.error.code !== "NOT_FOUND") {
      return c.json(
        {
          error: {
            message: result.error.message,
            code: result.error.code ?? "DATABASE_ERROR"
          }
        },
        500
      );
    }
    if (!result.data) {
      return c.json(
        { error: { message: "User not found", code: "NOT_FOUND" } },
        404
      );
    }
    return c.json({ result: toUserResponse(result.data) }, 200);
  });

  const updateProfileRoute = createRoute({
    method: "patch",
    path: "/users/me",
    tags: ["Users"],
    summary: "Update the caller's personal profile",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireAuth()] as const,
    request: {
      body: {
        content: { "application/json": { schema: UserProfileUpdateSchema } }
      }
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              result: z.object({ display_name: z.string().nullable() })
            })
          }
        },
        description: "Profile updated"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: ActiveAccountRequiredResponse,
      404: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Account does not exist or has been deleted"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(updateProfileRoute, async (c) => {
    const auth = getAuth(c);
    const body = c.req.valid("json");
    const users = new UsersDatabase(dependencies.database(c.env.DB_EXTENSIONS));
    const current = await users.get(auth.userId);
    if (current.error && current.error.code !== "NOT_FOUND") {
      return c.json(
        {
          error: {
            message: current.error.message,
            code: current.error.code ?? "DATABASE_ERROR"
          }
        },
        500
      );
    }
    if (!current.data || current.data.deletedAt !== null) {
      return c.json(
        { error: { message: "User not found", code: "NOT_FOUND" } },
        404
      );
    }
    const result = await users.updateDisplayName(
      auth.userId,
      body.display_name
    );
    if (result.error || !result.data) {
      return c.json(
        {
          error: {
            message: result.error?.message ?? "Unable to update profile",
            code: result.error?.code ?? "DATABASE_ERROR"
          }
        },
        statusFromErrorCode(result.error?.code, false)
      );
    }
    return c.json({ result: { display_name: result.data.displayName } }, 200);
  });

  const deleteUserRoute = createRoute({
    method: "delete",
    path: "/users/me",
    tags: ["Users"],
    summary: "Delete the caller's account and tombstone its user row",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireAuthAllowInactive()] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: z.object({ deleted: z.literal(true) }) })
          }
        },
        description: "Account deleted"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      404: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Account does not exist"
      },
      409: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Account still owns protected domain records"
      },
      500: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Database error"
      }
    }
  });

  app.openapi(deleteUserRoute, async (c) => {
    const auth = getAuth(c);
    const users = new UsersDatabase(dependencies.database(c.env.DB_EXTENSIONS));
    const result = await users.deleteAccount(auth.userId);
    if (result.error || !result.data) {
      return c.json(
        {
          error: {
            message: result.error?.message ?? "Unable to delete account",
            code: result.error?.code ?? "DATABASE_ERROR"
          }
        },
        statusFromErrorCode(result.error?.code)
      );
    }
    return c.json({ result: result.data }, 200);
  });
}
