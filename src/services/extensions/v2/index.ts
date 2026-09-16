import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { registerPublicExtensionsRoutes } from "./routes/public-extensions";
import { registerOwnerExtensionsRoutes } from "./routes/owner-extensions";
import { registerDeveloperProfileRoutes } from "./routes/developer-profiles";
import { registerOwnershipRoutes } from "./routes/ownership";
import { registerModerationRoutes } from "./routes/moderation";
import { registerAccountRoutes } from "./routes/account";
import { registerRevisionRoutes } from "./routes/revisions";

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
// routes/developer-profiles.ts) needs an explicit expose so callers can read
// it to schedule their retry.
extensionsV2.use("/*", cors({ origin: "*", exposeHeaders: ["Retry-After"] }));
extensionsV2.use("/*", trimTrailingSlash());
extensionsV2.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer"
});

// Merged reads (GET /extensions, GET /extensions/{id}, GET /developers/{id},
// GET /revisions) use optional auth and are role-aware, so there are no
// /extensions/mine or /moderation/* read siblings left to collide with.
// "mine" stays a reserved extension id (migration 0020) so an adopted row can
// never shadow a static route.
//
// Keep the developers parameter route last within its module: GET
// /developers/{id} would otherwise shadow static GET /developers/* routes
// (/developers/me, /developers/claims). Ownership registers before
// developer-profiles so /developers/claims (static) wins over /developers/{id}.
registerPublicExtensionsRoutes(extensionsV2);
registerOwnerExtensionsRoutes(extensionsV2);
registerAccountRoutes(extensionsV2);
registerOwnershipRoutes(extensionsV2);
registerModerationRoutes(extensionsV2);
registerRevisionRoutes(extensionsV2);
registerDeveloperProfileRoutes(extensionsV2);

extensionsV2.route(
  "/docs",
  Scalar.serve({
    document: () =>
      extensionsV2.getOpenAPI31Document({
        openapi: "3.1.0",
        info: {
          title: "FOSSBilling Extensions API (v2)",
          version: "2.0.0",
          description:
            "Self-service extension publishing, ownership, moderation, and public browsing. v1 (/extensions/v1) remains available for existing integrations."
        },
        servers: [{ url: "/extensions/v2" }]
      }),
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
      julia: true,
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
