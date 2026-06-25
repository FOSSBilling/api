import { Hono } from "hono";
import { contextStorage } from "hono/context-storage";
import { HTTPException } from "hono/http-exception";
import centralAlertsV1 from "../services/central-alerts/v1";
import extensionsV1 from "../services/extensions/v1";
import versionsV1 from "../services/versions/v1";
import statsV1 from "../services/stats/v1";
import { platformMiddleware } from "../lib/middleware";
import { createCloudflareBindings } from "../lib/adapters/cloudflare";
import { logError } from "../lib/logger";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use(contextStorage());

app.use("*", async (c, next) => {
  const bindings = createCloudflareBindings(c.env);
  const middleware = platformMiddleware(bindings);
  return middleware(c, next);
});

app.route("/central-alerts/v1", centralAlertsV1);
app.route("/extensions/v1", extensionsV1);
app.route("/versions/v1", versionsV1);
app.route("/stats/v1", statsV1);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  logError("app", "Unhandled request error", {
    message: err instanceof Error ? err.message : String(err)
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

export default app;
