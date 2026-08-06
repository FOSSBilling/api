import { createRoute, z } from "@hono/zod-openapi";
import { statusFromErrorCode, statusFromGithubErrorCode } from "./route-errors";
import {
  ActiveAccountRequiredResponse,
  DeveloperProfileSchema,
  DeveloperSchema,
  ErrorResponseSchema,
  IdParamSchema,
  OwnedDeveloperProfileSchema,
  PublicDeveloperSchema,
  ReverifyQuerySchema,
  toPublicDeveloper
} from "./interfaces";
import { DeveloperProfilesDatabase } from "./developer-profiles-database";
import { ExtensionsV2App, RouteDependencies } from "./route-dependencies";

export function registerDeveloperProfileRoutes(
  app: ExtensionsV2App,
  dependencies: RouteDependencies
): void {
  const getOwnDeveloperRoute = createRoute({
    method: "get",
    path: "/developers/me",
    tags: ["Developers"],
    summary: "Get the caller's own developer profile",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireAuth()] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: OwnedDeveloperProfileSchema.nullable() })
          }
        },
        description: "The caller's profile, or null when none exists"
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

  app.openapi(getOwnDeveloperRoute, async (c) => {
    const auth = dependencies.auth(c);
    const db = new DeveloperProfilesDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.getOwn(auth.userId);
    if (error || data === null) {
      if (error) {
        return c.json(
          {
            error: {
              message: error.message,
              code: error.code ?? "DATABASE_ERROR"
            }
          },
          500
        );
      }
      return c.json({ result: null }, 200);
    }
    return c.json({ result: data }, 200);
  });

  const upsertOwnDeveloperRoute = createRoute({
    method: "put",
    path: "/developers/me",
    tags: ["Developers"],
    summary: "Create or update the caller's own developer profile",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireAuth()] as const,
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
        description:
          "Developer profile created or updated and usable immediately"
      },
      401: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description: "Missing or invalid bearer token"
      },
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or this id matches a real GitHub organization or username that isn't linked to the caller's account"
      },
      409: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description:
          "Developer id already taken by someone else, or id was changed on an existing profile"
      },
      429: {
        content: { "application/json": { schema: ErrorResponseSchema } },
        description:
          "The account exhausted its profile-creation allowance, or GitHub verification is temporarily rate limited"
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

  app.openapi(upsertOwnDeveloperRoute, async (c) => {
    const auth = dependencies.auth(c);
    const body = c.req.valid("json");
    const platform = dependencies.platform(c);
    const db = new DeveloperProfilesDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.upsertOwn(
      auth.userId,
      body,
      platform.getEnv("GITHUB_TOKEN"),
      // Cloudflare enforces the configured 3-per-60s account allowance across
      // isolates. Keep this as a callback so upsertOwn can run its cheap
      // existing-profile/id checks first; updates and known-taken ids must not
      // spend creation allowance.
      async () =>
        (
          await c.env.PROFILE_CREATION_RATE_LIMITER.limit({
            key: auth.userId
          })
        ).success
    );
    if (error || !data) {
      const status =
        error?.code === "GITHUB_MISMATCH" || error?.code === "ACCOUNT_INACTIVE"
          ? 403
          : error?.code === "PROFILE_CREATION_RATE_LIMITED"
            ? 429
            : error?.code === "CONFLICT" || error?.code === "DEVELOPER_ID_TAKEN"
              ? 409
              : statusFromGithubErrorCode(error?.code, 500);
      const response = c.json(
        {
          error: {
            message: error?.message ?? "Unable to save developer profile",
            code: error?.code ?? "DATABASE_ERROR"
          }
        },
        status
      );
      if (error?.code === "PROFILE_CREATION_RATE_LIMITED") {
        response.headers.set("Retry-After", "60");
      }
      return response;
    }
    return c.json({ result: data }, 200);
  });

  const deleteOwnDeveloperRoute = createRoute({
    method: "delete",
    path: "/developers/me",
    tags: ["Developers"],
    summary: "Permanently delete the caller's own developer profile",
    security: [{ Bearer: [] }],
    middleware: [dependencies.requireAuth()] as const,
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
      403: ActiveAccountRequiredResponse,
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

  app.openapi(deleteOwnDeveloperRoute, async (c) => {
    const auth = dependencies.auth(c);
    const db = new DeveloperProfilesDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.deleteOwn(auth.userId);
    if (error || !data) {
      return c.json(
        {
          error: {
            message: error?.message ?? "Unable to delete developer profile",
            code: error?.code ?? "DATABASE_ERROR"
          }
        },
        error?.code === "ACCOUNT_INACTIVE"
          ? 403
          : statusFromErrorCode(error?.code)
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
    middleware: [dependencies.requireAuth()] as const,
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
      403: ActiveAccountRequiredResponse,
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

  app.openapi(reverifyOwnDeveloperRoute, async (c) => {
    const auth = dependencies.auth(c);
    const { check_url } = c.req.valid("query");
    const platform = dependencies.platform(c);
    const db = new DeveloperProfilesDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
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

  // This parameter route must be registered after static GET /developers/* routes.
  // The composition root enforces that ordering by registering this module last.
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

  app.openapi(getDeveloperRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = new DeveloperProfilesDatabase(
      dependencies.database(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.getById(id);
    if (error || !data) {
      const status = statusFromErrorCode(error?.code, false);
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
}
