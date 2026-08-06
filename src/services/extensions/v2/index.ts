import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { registerPublicExtensionsRoutes } from "./routes/public-extensions";
import { registerOwnerExtensionsRoutes } from "./routes/owner-extensions";
import { registerSubmissionRoutes } from "./routes/submissions";
import { registerDeveloperProfileRoutes } from "./routes/developer-profiles";
import { registerOwnershipRoutes } from "./routes/ownership";
import { registerModerationRoutes } from "./routes/moderation";
import { registerAccountRoutes } from "./routes/account";

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

// Register the static owner route before the public parameter route
// (/extensions/{id}) so the reserved "mine" segment is handled as the
// owner collection. New submissions reject the reserved id; adopted rows
// predate that, and migration 0020 fails if one is present.
registerOwnerExtensionsRoutes(extensionsV2);
registerPublicExtensionsRoutes(extensionsV2);
registerAccountRoutes(extensionsV2);
registerSubmissionRoutes(extensionsV2);
registerOwnershipRoutes(extensionsV2);
registerModerationRoutes(extensionsV2);
// Keep this last: its GET /developers/{id} parameter route would otherwise
// shadow static GET /developers/* routes registered by the modules above.
// The "me" namespace is reserved for the owner profile route; adopted rows
// are covered by the same migration 0020 check.
registerDeveloperProfileRoutes(extensionsV2);

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
