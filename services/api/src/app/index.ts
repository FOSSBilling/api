import {
  consumePackagingJobs,
  recoverPackagingJobs
} from "../lib/adapters/cloudflare/packaging-jobs";
import { getExtensionsDb } from "../lib/db";
import {
  maintainExtensionResources,
  reportExtensionResources
} from "../services/extensions/v2/db/resource-maintenance";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import centralAlertsV1 from "../services/central-alerts/v1/index";
import extensionsV1 from "../services/extensions/v1/index";
import extensionsV2 from "../services/extensions/v2/index";
import previewsV1 from "../services/previews/v1/index";
import versionsV1 from "../services/versions/v1/index";
import statsV1 from "../services/stats/v1/index";
import { platformMiddleware } from "../lib/middleware";
import { createCloudflareBindings } from "../lib/adapters/cloudflare/index";
import { logError } from "@fossbilling/logging";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use("*", async (c, next) => {
  const bindings = createCloudflareBindings(c.env);
  const middleware = platformMiddleware(bindings, (promise) =>
    c.executionCtx.waitUntil(promise)
  );
  return middleware(c, next);
});

app.route("/central-alerts/v1", centralAlertsV1);
app.route("/extensions/v1", extensionsV1);
app.route("/extensions/v2", extensionsV2);
app.route("/previews/v1", previewsV1);
app.route("/versions/v1", versionsV1);
app.route("/stats/v1", statsV1);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  logError("app", "Unhandled request error", {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined
  });
  return c.json(
    {
      result: null,
      error: {
        message: "Internal Server Error",
        code: "INTERNAL_SERVER_ERROR"
      }
    },
    500
  );
});

// Handle root path
app.get("/", (c) => {
  return c.json({
    result: null,
    error_code: 0,
    message:
      "FOSSBilling API. See https://github.com/FOSSBilling/api for documentation."
  });
});

// Handle unknown routes
app.all("/*", (c) => {
  return c.json(
    {
      result: null,
      error: {
        message: "Route not found",
        code: "ROUTE_NOT_FOUND"
      }
    },
    404
  );
});

export default {
  queue: consumePackagingJobs,
  fetch: app.fetch,
  request: app.request.bind(app),
  scheduled: async (
    _event: ScheduledController,
    env: CloudflareBindings
  ): Promise<void> => {
    try {
      await recoverPackagingJobs(env);
    } catch (error) {
      logError("extensions/packages", "Packaging job recovery failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    const db = getExtensionsDb(env.DB_EXTENSIONS);
    await maintainExtensionResources(db, {
      mode: env.EXTENSIONS_RETENTION_MODE
    });
    await reportExtensionResources(db, env.EXTENSIONS_RETENTION_MODE);
  }
};

// wrangler's main module must export the Durable Object classes bound in
// wrangler.jsonc; the implementation lives with the previews service, which
// owns its rate-limit policy.
export { PreviewGitHubBudget } from "../services/previews/v1/budget";
