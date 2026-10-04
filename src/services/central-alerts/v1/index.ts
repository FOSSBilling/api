import { Hono } from "hono";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { CentralAlertsDatabase } from "./database";
import { getCentralAlertsDb } from "../../../lib/db";
import { logError } from "../../../lib/logger";

const centralAlertsV1 = new Hono<{ Bindings: CloudflareBindings }>();

centralAlertsV1.use("/*", cors({ origin: "*" }), trimTrailingSlash());

// Admin panels poll this public representation constantly. Parse once before
// cache lookup so ignored inputs cannot create new entries for the same page.
centralAlertsV1.get("/list", async (c) => {
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

  const cacheUrl = new URL(c.req.url);
  // Hono decodes path aliases before routing; key that same routed path.
  cacheUrl.pathname = c.req.path;
  cacheUrl.search = "";
  cacheUrl.hash = "";
  if (page) {
    cacheUrl.searchParams.set("limit", String(page.limit));
    cacheUrl.searchParams.set("offset", String(page.offset));
  }
  // This route never authenticates or varies by Authorization. Use a
  // header-free key so that arbitrary credentials cannot force a D1 read.
  const edgeCache =
    typeof caches !== "undefined"
      ? await caches.open("central-alerts-v1")
      : undefined;
  const cached = await edgeCache?.match(cacheUrl.href);
  if (cached) return new Response(cached.body, cached);

  const db = new CentralAlertsDatabase(
    getCentralAlertsDb(c.env.DB_CENTRAL_ALERTS)
  );
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

  c.header("Cache-Control", "max-age=60");
  const response = c.json({
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
  if (edgeCache) {
    c.executionCtx.waitUntil(edgeCache.put(cacheUrl.href, response.clone()));
  }
  return response;
});

export default centralAlertsV1;
