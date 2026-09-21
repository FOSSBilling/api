import { Hono } from "hono";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { makeBadge } from "badge-maker";
import { getExtensionsDb } from "../../../lib/db";
import { singleFlight } from "../../../lib/cache";
import { ExtensionsDatabase } from "./database";
import { listCacheKey, LIST_CACHE_TTL_SECONDS } from "./list-cache";

const extensionsV1 = new Hono<{ Bindings: CloudflareBindings }>();

extensionsV1.use("/*", cors({ origin: "*" }));
extensionsV1.use("/*", trimTrailingSlash());

// The assembled list is ~126KB of readme + release history per entry, rebuilt
// from a full-table D1 read (per the documented legacy contract) on every
// request - yet catalogue content changes at human speed. Cache the serialized
// response body in CACHE_KV and let concurrent cold misses share one build per
// isolate. Cached responses freeze today's otherwise-nondeterministic row
// order, which is a strict improvement for consumers diffing consecutive polls.

extensionsV1.get("/list", async (c) => {
  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
  const type = c.req.query("type");

  // Opt-in pagination: absent params keep the exact original contract
  // (every published extension, no pagination object). A non-numeric limit
  // is treated as absent rather than a 400 - this legacy surface has never
  // validated query params. offset is the exception: only a caller opting
  // into pagination can send it, so offset without a usable limit is a 422
  // (matching the v2 pagination endpoints) rather than a silently ignored
  // param that returns the full list.
  const limitParam = Number(c.req.query("limit"));
  const hasValidLimit =
    Number.isInteger(limitParam) && limitParam >= 1 && limitParam <= 100;
  const rawOffset = c.req.query("offset");
  if (rawOffset !== undefined && !hasValidLimit) {
    return c.json({ error: { message: "offset requires limit" } }, 422);
  }
  const offsetParam = rawOffset === undefined ? 0 : Number(rawOffset);
  const page = hasValidLimit
    ? {
        limit: limitParam,
        offset:
          Number.isInteger(offsetParam) && offsetParam >= 0 ? offsetParam : 0
      }
    : undefined;

  const cacheKey = listCacheKey(type, page);

  const respond = async (): Promise<Response> => {
    const cached = await c.env.CACHE_KV.get(cacheKey);
    if (cached) {
      return c.body(cached, 200, { "Content-Type": "application/json" });
    }

    const { data, error } = await db.getAllExtensions(type, page);
    if (error) {
      return c.json({ error: { message: "Unable to load extensions" } }, 500);
    }

    const body = JSON.stringify({
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
      c.env.CACHE_KV.put(cacheKey, body, {
        expirationTtl: LIST_CACHE_TTL_SECONDS
      })
    );
    return c.body(body, 200, { "Content-Type": "application/json" });
  };

  // One KV read + one D1 read per cold burst instead of one per request;
  // failures propagate so nothing error-shaped is ever cached.
  return singleFlight(cacheKey, respond);
});

extensionsV1.get("/:id/badges/:type", async (c) => {
  const id = c.req.param("id");
  const badgeType = c.req.param("type");

  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data: badgeData, error } = await db.getExtensionBadgeData(id);
  if (error || !badgeData) {
    const status = error?.code === "NOT_FOUND" ? 404 : 500;
    return c.json(
      { error: { message: error?.message ?? "Extension not found" } },
      status
    );
  }

  const latest = badgeData.latestRelease;

  const knownTypes: Record<string, { label: string; message: string }> = {
    version: {
      label: "Latest version",
      message: latest ? `v${latest.tag}` : "unknown"
    },
    min_fossbilling_version: {
      label: "Minimum FOSSBilling version",
      message: latest ? `v${latest.min_fossbilling_version}` : "unknown"
    },
    license: {
      label: "License",
      message: badgeData.license.name
    }
  };

  const matched = knownTypes[badgeType.toLowerCase()];
  const format = {
    label: matched ? matched.label : "Unknown type",
    message: matched ? matched.message : badgeType,
    color: matched ? "blue" : "red"
  };

  const colorParam = c.req.query("color");
  if (colorParam) {
    format.color = colorParam;
  }

  // Badges are embedded in READMEs and re-fetched by crawlers and shields
  // proxies constantly; the underlying data changes only when a release
  // lands, so let the CDN carry the traffic.
  c.header("Cache-Control", "public, max-age=300, s-maxage=3600");
  // Static import: wrangler's esbuild doesn't code-split, so a dynamic
  // import here would just be inlined back into the bundle.
  const svg = makeBadge(format);
  c.header("Content-Type", "image/svg+xml");
  return c.body(svg);
});

extensionsV1.get("/:id/version", async (c) => {
  const id = c.req.param("id");

  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data: badgeData, error } = await db.getExtensionBadgeData(id);
  if (error || !badgeData) {
    const status = error?.code === "NOT_FOUND" ? 404 : 500;
    return c.json(
      { error: { message: error?.message ?? "Extension not found" } },
      status
    );
  }

  const latest = badgeData.latestRelease;
  if (!latest) {
    return c.json({ error: { message: "No releases found" } }, 500);
  }

  c.header("Cache-Control", "public, max-age=300, s-maxage=3600");
  return c.text(latest.tag);
});

extensionsV1.get("/:id", async (c) => {
  const id = c.req.param("id");

  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data: extension, error } = await db.getExtensionById(id);
  if (error || !extension) {
    const status = error?.code === "NOT_FOUND" ? 404 : 500;
    return c.json(
      { error: { message: error?.message ?? "Extension not found" } },
      status
    );
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
