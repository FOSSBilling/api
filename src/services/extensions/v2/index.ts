import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { MiddlewareHandler } from "hono";
import { getAuth, requireAuth } from "../../../lib/auth";
import { getExtensionsDb } from "../../../lib/db";
import { getPlatform } from "../../../lib/middleware";
import { UsersDatabase } from "./users-database";
import { registerPublicExtensionsRoutes } from "./public-extensions-routes";
import { registerSubmissionRoutes } from "./submission-routes";
import { registerDeveloperProfileRoutes } from "./developer-profile-routes";
import { registerOwnershipRoutes } from "./ownership-routes";
import { registerModerationRoutes } from "./moderation-routes";
import { RouteDependencies } from "./route-dependencies";

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
  requireAuth,
  requireModerator
};

registerPublicExtensionsRoutes(extensionsV2, dependencies);
registerSubmissionRoutes(extensionsV2, dependencies);
registerOwnershipRoutes(extensionsV2, dependencies);
registerModerationRoutes(extensionsV2, dependencies);
// Keep this last: its GET /developers/{id} parameter route would otherwise
// shadow static GET /developers/* routes registered by the modules above.
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
