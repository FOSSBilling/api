import { Hono } from "hono";
import { cache } from "hono/cache";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { CentralAlertsDatabase } from "./database";
import { getCentralAlertsDb } from "../../../lib/db";
import { publicCacheKey } from "../../../lib/cache";
import { logError } from "../../../lib/logger";

const centralAlertsV1 = new Hono<{ Bindings: CloudflareBindings }>();

centralAlertsV1.use("/*", cors({ origin: "*" }), trimTrailingSlash());

// Admin panels poll this route constantly; the alert set changes at human
// speed, so an edge-cached response with a short window keeps those polls
// off D1. Authorization-bearing requests skip the cache (hono default), and
// only 200s are stored, so validation failures and D1 errors stay live.
centralAlertsV1.get(
  "/list",
  cache({
    cacheName: "central-alerts-v1",
    cacheControl: "max-age=60",
    keyGenerator: publicCacheKey
  }),
  async (c) => {
    const db = new CentralAlertsDatabase(
      getCentralAlertsDb(c.env.DB_CENTRAL_ALERTS)
    );

    // Opt-in pagination: absent params keep the full-list contract. A
    // non-numeric limit is treated as absent rather than a 400 - this route
    // has never validated query params and FOSSBilling's client passes none.
    // offset is the exception: only a caller opting into pagination can send
    // it, so offset without a usable limit is a 422 (matching the v2
    // pagination endpoints) rather than a silently ignored param.
    const limitParam = Number(c.req.query("limit"));
    const hasValidLimit =
      Number.isInteger(limitParam) && limitParam >= 1 && limitParam <= 100;
    const rawOffset = c.req.query("offset");
    if (rawOffset !== undefined && !hasValidLimit) {
      return c.json(
        {
          result: null,
          error: { message: "offset requires limit", code: "VALIDATION_ERROR" }
        },
        422
      );
    }
    const offsetParam = rawOffset === undefined ? 0 : Number(rawOffset);
    const page = hasValidLimit
      ? {
          limit: limitParam,
          offset:
            Number.isInteger(offsetParam) && offsetParam >= 0 ? offsetParam : 0
        }
      : undefined;

    const { data, error } = await db.getAllAlerts(page);

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
      result: {
        alerts: data?.alerts || [],
        ...(page && data
          ? {
              pagination: {
                limit: page.limit,
                offset: page.offset,
                has_more: data.hasMore
              }
            }
          : {})
      },
      error: null
    });
  }
);

export default centralAlertsV1;
