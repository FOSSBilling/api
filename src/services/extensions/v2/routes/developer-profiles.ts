import {
  getOptionalAuth,
  optionalAuth,
  requireActiveAuth,
  requireModerator
} from "../middleware";
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
  DeveloperDetailResponseSchema,
  DeveloperListQuerySchema,
  DeveloperProfileSchema,
  DeveloperInputSchema,
  OwnedDeveloperProfileSchema,
  ReverifyQuerySchema,
  toPublicDeveloper
} from "../schemas/developers";
import { DeveloperProfilesDatabase } from "../db/developer-profiles";
import { UsersDatabase } from "../db/users";
import { ExtensionsV2App } from "./app";

export function registerDeveloperProfileRoutes(app: ExtensionsV2App): void {
  const listDevelopersRoute = createRoute({
    method: "get",
    path: "/developers",
    tags: ["Moderation"],
    summary:
      "List developer profiles: every profile (status=all) or awaiting review (status=unapproved)",
    security: [{ Bearer: [] }],
    middleware: [requireModerator()] as const,
    request: { query: DeveloperListQuerySchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({ result: z.array(DeveloperProfileSchema) })
          }
        },
        description: "Developer profiles matching the status filter"
      },
      401: errorResponse("Missing or invalid bearer token"),
      403: {
        ...ActiveAccountRequiredResponse,
        description: "The account is inactive or the caller is not a moderator"
      },
      422: errorResponse("status query failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(listDevelopersRoute, async (c) => {
    const { status } = c.req.valid("query");
    const db = new DeveloperProfilesDatabase(
      getExtensionsDb(c.env.DB_EXTENSIONS)
    );
    const { data, error } = await db.listScoped({ status });
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

  // This parameter route must be registered after static GET /developers/*
  // routes (claims, me). "unapproved" stays reserved but is no longer a live
  // route, having merged into GET /developers?status=.
  const getDeveloperRoute = createRoute({
    method: "get",
    path: "/developers/{id}",
    tags: ["Developers"],
    summary:
      "Get a developer profile: public view anonymously, full view for the owner or a moderator",
    security: [{ Bearer: [] }],
    middleware: [optionalAuth()] as const,
    request: { params: IdParamSchema },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: DeveloperDetailResponseSchema
          }
        },
        description:
          "Public profile for anonymous callers, owned/full profile for the owner or a moderator"
      },
      401: errorResponse("Invalid bearer token"),
      404: errorResponse("No developer with that id"),
      422: errorResponse("id param failed validation"),
      500: errorResponse("Database error")
    }
  });

  app.openapi(getDeveloperRoute, async (c) => {
    const { id } = c.req.valid("param");
    const auth = getOptionalAuth(c);
    const extDb = getExtensionsDb(c.env.DB_EXTENSIONS);
    const db = new DeveloperProfilesDatabase(extDb);
    if (auth) {
      const own = await db.getOwn(auth.userId);
      if (
        !own.error &&
        own.data &&
        own.data.id.toLowerCase() === id.toLowerCase()
      ) {
        const res = c.json({ result: own.data }, 200);
        res.headers.set("Vary", "Authorization");
        return res;
      }
      if (own.error) {
        return c.json(errorBody(own.error, "Unable to load developer"), 500);
      }
      const users = new UsersDatabase(extDb);
      const access = await users.moderatorAccess(auth.userId);
      if (access.error) {
        return c.json(errorBody(access.error, "Unable to check access"), 500);
      }
      if (access.data?.moderator) {
        const { data, error } = await db.getById(id);
        if (error || !data) {
          const status = statusFromErrorCode(error?.code, false);
          return c.json(errorBody(error, "Developer not found"), status);
        }
        const res = c.json({ result: data }, 200);
        res.headers.set("Vary", "Authorization");
        return res;
      }
    }
    const { data, error } = await db.getById(id);
    if (error || !data) {
      const status = statusFromErrorCode(error?.code, false);
      return c.json(errorBody(error, "Developer not found"), status);
    }
    const res = c.json({ result: toPublicDeveloper(data) }, 200);
    if (auth) res.headers.set("Vary", "Authorization");
    else
      res.headers.set(
        "Cache-Control",
        "public, max-age=60, s-maxage=300, stale-while-revalidate=600"
      );
    return res;
  });
}
