import { Hono } from "hono";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { CentralAlertsDatabase } from "./database";
import { getPlatform } from "../../../lib/middleware";
import { logError } from "../../../lib/logger";

const centralAlertsV1 = new Hono<{ Bindings: CloudflareBindings }>();

centralAlertsV1.use("/*", cors({ origin: "*" }), trimTrailingSlash());

centralAlertsV1.get("/list", async (c) => {
  const platform = getPlatform(c);
  const db = new CentralAlertsDatabase(
    platform.getDatabase("DB_CENTRAL_ALERTS")
  );
  const { data, error } = await db.getAllAlerts();

  if (error) {
    logError("central-alerts", "Failed to list central alerts", {
      message: error.message,
      code: error.code
    });
    return c.json(
      {
        result: null,
        error: {
          message: "Unable to load central alerts",
          code: error.code || "DATABASE_ERROR"
        }
      },
      500
    );
  }

  return c.json({
    result: { alerts: data || [] },
    error: null
  });
});

export default centralAlertsV1;
