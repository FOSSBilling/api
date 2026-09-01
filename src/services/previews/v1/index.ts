import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { registerMainRoutes } from "./routes/main";
import { registerPrRoutes } from "./routes/pr";
import { registerCommitRoutes } from "./routes/commit";

const previewsV1 = new OpenAPIHono<{ Bindings: CloudflareBindings }>({
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

previewsV1.use("/*", cors({ origin: "*" }));
previewsV1.use("/*", trimTrailingSlash());

registerMainRoutes(previewsV1);
registerPrRoutes(previewsV1);
registerCommitRoutes(previewsV1);

previewsV1.route(
  "/docs",
  Scalar.serve({
    document: () => 
      previewsV1.getOpenAPI31Document({
        openapi: "3.1.0",
        info: {
          title: "FOSSBilling Previews API (v1)",
          version: "1.0.0",
          description:
            "Read-only lookup of FOSSBilling preview builds - the current main preview and per-PR/per-commit builds produced by FOSSBilling/FOSSBilling's GitHub Actions workflows."
        },
        servers: [{ url: "/previews/v1" }]
      }),
    pageTitle: "FOSSBilling Previews API (v1)",
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

export default previewsV1;
