import { requireActiveAuth } from "../middleware";
import { getExtensionsDb } from "../../../../lib/db";
import { getPlatform } from "../../../../lib/middleware";
import { getAuth } from "../../../../lib/auth";
import { createRoute, z } from "@hono/zod-openapi";
import {
  errorBody,
  statusFromErrorCode,
  statusFromGithubErrorCode
} from "./errors";
import {
  ActiveAccountRequiredResponse,
  IdParamSchema,
  errorResponse
} from "../schemas/common";
import {
  DeveloperProfileSchema,
  DeveloperInputSchema,
  OwnedDeveloperProfileSchema,
  PublicDeveloperSchema,
  ReverifyQuerySchema,
  toPublicDeveloper
} from "../schemas/developers";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import { ExtensionsV2App } from "./app";

export function registerDeveloperProfileRoutes(app: ExtensionsV2App): void {
  const getOwnDeveloperRoute = createRoute({
    method: "get",
    path: "/developers/me",
    tags: ["Developers"],
    summary: "Get the caller's own developer profile",
    security: [{ Bearer: [] }],
    middleware: [requireActiveAuth()] as const,
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: OwnedDeveloperProfileSchema.nullable() })
          }
        },
        description: "The caller's profile, or null when none exists"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: ActiveAccountRequiredResponse,
      500: errorResponse("Database error")
    }
  });

  app.openapi(getOwnDeveloperRoute, async (c) => {
    const auth = getAuth(c);
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
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
    middleware: [requireActiveAuth()] as const,
    request: {
      body: {
        content: { "application/json": { schema: DeveloperInputSchema } }
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
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description:
          "The account is inactive, or this id matches a real GitHub organization or username that isn't linked to the caller's account"
      },
      409: errorResponse(
        "Developer id already taken by someone else, or id was changed on an existing profile"
      ),
      429: errorResponse(
        "The account exhausted its profile-creation allowance, or GitHub verification is temporarily rate limited"
      ),
      503: errorResponse("GitHub verification is temporarily unavailable"),
      422: errorResponse(
        "Payload failed validation, or the GitHub account type is unsupported"
      ),
      500: errorResponse("Database error")
    }
  });

  app.openapi(upsertOwnDeveloperRoute, async (c) => {
    const auth = getAuth(c);
    const body = c.req.valid("json");
    const platform = getPlatform(c);
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
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
        errorBody(error, "Unable to save developer profile"),
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
    middleware: [requireActiveAuth()] as const,
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
      401: errorResponse("Missing or invalid bearer token"),
      403: ActiveAccountRequiredResponse,
      404: errorResponse("Caller has no developer profile"),
      409: errorResponse(
        "Profile still has extensions attached, published or not"
      ),
      500: errorResponse("Database error")
    }
  });

  app.openapi(deleteOwnDeveloperRoute, async (c) => {
    const auth = getAuth(c);
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.deleteOwn(auth.userId);
    if (error || !data) {
      return c.json(
        errorBody(error, "Unable to delete developer profile"),
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
    middleware: [requireActiveAuth()] as const,
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
      401: errorResponse("Missing or invalid bearer token"),
      403: ActiveAccountRequiredResponse,
      404: errorResponse("Caller has no developer profile"),
      409: errorResponse("Developer ownership changed while re-verifying"),
      429: errorResponse(
        "check_url was used again too soon, or GitHub verification is rate limited"
      ),
      503: errorResponse("GitHub verification is temporarily unavailable"),
      422: errorResponse("The GitHub account type is unsupported"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(reverifyOwnDeveloperRoute, async (c) => {
    const auth = getAuth(c);
    const { check_url } = c.req.valid("query");
    const platform = getPlatform(c);
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.reverifyOwn(
      auth.userId,
      check_url,
      platform.getEnv("GITHUB_TOKEN")
    );
    if (error || !data) {
      const status =
        error?.code === "ACCOUNT_INACTIVE"
          ? 403
          : statusFromGithubErrorCode(
              error?.code,
              statusFromErrorCode(error?.code)
            );
      return c.json(
        errorBody(error, "Unable to re-verify developer profile"),
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
      404: errorResponse("No developer with that id"),
      422: errorResponse("id param failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(getDeveloperRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.getById(id);
    if (error || !data) {
      const status = statusFromErrorCode(error?.code, false);
      return c.json(errorBody(error, "Developer not found"), status);
    }
    return c.json({ result: toPublicDeveloper(data) }, 200);
  });
}
