import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { getExtensionsDb } from "../../../lib/db";
import { singleFlight } from "../../../lib/cache";
import { parseLegacyPagination } from "../../../lib/pagination";
import { ExtensionsDatabase } from "./database";
import { listCacheKey, LIST_CACHE_TTL_SECONDS } from "./list-cache";

const extensionsV1 = new Hono<{ Bindings: CloudflareBindings }>();

// Shared failure shape for this service's plain-JSON routes: the database's
// message when present, 404 only for its NOT_FOUND code.
function extensionError(
  c: Context<{ Bindings: CloudflareBindings }>,
  error: { message: string; code?: string } | null | undefined
) {
  return c.json(
    { error: { message: error?.message ?? "Extension not found" } },
    error?.code === "NOT_FOUND" ? 404 : 500
  );
}

extensionsV1.use("/*", cors({ origin: "*" }));
extensionsV1.use("/*", trimTrailingSlash());

// The assembled list is ~126KB of readme + release history per entry, rebuilt
// from a full-table D1 read (per the documented legacy contract) on every
// request - yet extension content changes at human speed. Cache the serialized
// response body in CACHE_KV and let concurrent cold misses share one build per
// isolate; a cached response also freezes the unpaginated query's otherwise
// nondeterministic row order.

extensionsV1.get("/list", async (c) => {
  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
  const type = c.req.query("type");

  const page = parseLegacyPagination({
    limit: c.req.query("limit"),
    offset: c.req.query("offset")
  });
  if (page === "invalid") {
    return c.json({ error: { message: "offset requires limit" } }, 422);
  }
  const cacheKey = listCacheKey(type, page);

  // singleFlight coalesces the serialized body STRING, not the Response:
  // a Response's body stream is single-use, so sharing one Response object
  // across a cold burst would break every request after the first. Each
  // caller builds its own Response from the shared string. Cache-read
  // failures fall through to D1 - the cache is an optimization, not an
  // availability dependency - and the write is best-effort (a failed put
  // merely leaves the next request paying for a rebuild).
  const body = await singleFlight(
    cacheKey,
    async (): Promise<string | null> => {
      let cached: string | null = null;
      try {
        cached = await c.env.CACHE_KV.get(cacheKey);
      } catch {
        // Fall through to the D1 build.
      }
      if (cached) return cached;

      const { data, error } = await db.getAllExtensions(type, page);
      if (error) return null;

      const serialized = JSON.stringify({
        result: data?.extensions || [],
        ...(page && data
          ? {
              pagination: {
                limit: page.limit,
                offset: page.offset,
                has_more: data.hasMore
              }
            }
          : {})
      });
      c.executionCtx.waitUntil(
        c.env.CACHE_KV.put(cacheKey, serialized, {
          expirationTtl: LIST_CACHE_TTL_SECONDS
        }).catch(() => {})
      );
      return serialized;
    }
  );

  if (body === null) {
    return c.json({ error: { message: "Unable to load extensions" } }, 500);
  }
  return c.body(body, 200, { "Content-Type": "application/json" });
});

extensionsV1.get("/:id/version", async (c) => {
  const id = c.req.param("id");

  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data, error } = await db.getExtensionVersion(id);
  if (error || !data) {
    return extensionError(c, error);
  }

  if (data.version === null) {
    return c.json({ error: { message: "No releases found" } }, 500);
  }

  c.header("Cache-Control", "public, max-age=300, s-maxage=3600");
  return c.text(data.version);
});

extensionsV1.get("/:id", async (c) => {
  const id = c.req.param("id");

  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data: extension, error } = await db.getExtensionById(id);
  if (error || !extension) {
    return extensionError(c, error);
  }

  // Same shape as the v2 public detail route: short client TTL, CDN holds
  // the (potentially ~100KB readme-bearing) body for longer.
  c.header(
    "Cache-Control",
    "public, max-age=60, s-maxage=300, stale-while-revalidate=600"
  );
  return c.json({ result: extension });
});

export default extensionsV1;
