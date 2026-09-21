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

// Merged reads (GET /extensions, GET /extensions/{id}, GET /developers/{id})
// use optional auth and are role-aware. Revision history stays nested as
// GET /extensions/{id}/revisions (a true sub-collection next to the approve
// and reject writes), while GET /revisions is the moderator-only global
// queue — the two-segment history path cannot collide with the single-segment
// detail read, so no id reservation is needed for either.
// "mine" is an ordinary extension id now that no static segment shadows it;
// the developers {id} reservation remains for the live me/claims routes (and
// conservatively for unapproved, migration 0020) because a matching adopted
// row would still be unreachable.
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

// The document is deterministic once every route is registered, so build
// it once per isolate on the first /docs request.
type OpenApiDocument = ReturnType<typeof extensionsV2.getOpenAPI31Document>;
let cachedOpenApiDocument: OpenApiDocument | null = null;

extensionsV2.route(
  "/docs",
  Scalar.serve({
    document: () =>
      (cachedOpenApiDocument ??= extensionsV2.getOpenAPI31Document({
        openapi: "3.1.0",
        info: {
          title: "FOSSBilling Extensions API (v2)",
          version: "2.0.0",
          description:
            "Self-service extension publishing, ownership, moderation, and public browsing. v1 (/extensions/v1) remains available for existing integrations."
        },
        servers: [{ url: "/extensions/v2" }]
      })),
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
