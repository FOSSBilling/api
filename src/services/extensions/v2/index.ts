import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { type Context, type MiddlewareHandler } from "hono";
import { getAuth, requireAuth } from "../../../lib/auth";
import { getExtensionsDb } from "../../../lib/db";
import { getPlatform } from "../../../lib/middleware";
import { UsersDatabase } from "./users-database";
import { registerPublicExtensionsRoutes } from "./public-extensions-routes";
import { registerOwnerExtensionsRoutes } from "./owner-extensions-routes";
import { registerSubmissionRoutes } from "./submission-routes";
import { registerDeveloperProfileRoutes } from "./developer-profile-routes";
import { registerOwnershipRoutes } from "./ownership-routes";
import { registerModerationRoutes } from "./moderation-routes";
import { registerAccountRoutes } from "./account-routes";
import { RouteDependencies } from "./route-dependencies";

const requireAuthAllowInactive = requireAuth;

type AuthenticatedCheck = (c: Context) => Promise<Response | undefined>;

function withAuthenticatedCheck(check: AuthenticatedCheck): MiddlewareHandler {
  const authenticate = requireAuth();
  return async (c, next) => {
    let response: Response | undefined;
    const authenticationResult = await authenticate(c, async () => {
      const checkResponse = await check(c);
      if (checkResponse) {
        response = checkResponse;
      } else {
        await next();
      }
    });
    return response ?? authenticationResult;
  };
}

function requireActiveAuth(): MiddlewareHandler {
  return withAuthenticatedCheck(async (c) => {
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const result = await users.isActive(getAuth(c).userId);
    if (result.error) return c.json({ error: result.error }, 500);
    if (!result.data) {
      return c.json(
        {
          error: {
            message: "Active account required",
            code: "ACCOUNT_INACTIVE"
          }
        },
        403
      );
    }
  });
}

function requireIdentitySync(): MiddlewareHandler {
  return withAuthenticatedCheck(async (c) => {
    if (getAuth(c).scope !== "assertion") {
      return c.json(
        {
          error: {
            message: "Identity synchronization requires a trusted assertion",
            code: "FORBIDDEN"
          }
        },
        403
      );
    }
  });
}

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

// exposeHeaders: browsers hide non-safelisted response headers from
// cross-origin JS by default; Retry-After (set on 429s, see
// developer-profile-routes.ts) needs an explicit expose so callers can read
// it to schedule their retry.
extensionsV2.use("/*", cors({ origin: "*", exposeHeaders: ["Retry-After"] }));
extensionsV2.use("/*", trimTrailingSlash());
extensionsV2.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer"
});

function requireModerator(): MiddlewareHandler {
  return async (c, next) => {
    const auth = getAuth(c);
    const users = new UsersDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
    const result = await users.isModerator(auth.userId);
    if (result.error) return c.json({ error: result.error }, 500);
    if (!result.data)
      return c.json(
        { error: { message: "Moderator access required", code: "FORBIDDEN" } },
        403
      );
    await next();
  };
}

const dependencies: RouteDependencies = {
  database: getExtensionsDb,
  auth: getAuth,
  platform: getPlatform,
  requireAuth: requireActiveAuth,
  requireAuthAllowInactive,
  requireIdentitySync,
  requireModerator
};

// Register the static owner route before the public parameter route
// (/extensions/{id}) so the reserved "mine" segment is handled as the
// owner collection. The deployment preflight in README.md must reject any
// pre-existing extension with that id before this route is enabled.
registerOwnerExtensionsRoutes(extensionsV2, dependencies);
registerPublicExtensionsRoutes(extensionsV2, dependencies);
registerAccountRoutes(extensionsV2, dependencies);
registerSubmissionRoutes(extensionsV2, dependencies);
registerOwnershipRoutes(extensionsV2, dependencies);
registerModerationRoutes(extensionsV2, dependencies);
// Keep this last: its GET /developers/{id} parameter route would otherwise
// shadow static GET /developers/* routes registered by the modules above.
// The "me" namespace is reserved for the owner profile route; the rollout
// preflight must reject a pre-existing developer with that id.
registerDeveloperProfileRoutes(extensionsV2, dependencies);

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
    agent: { disabled: true },
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
