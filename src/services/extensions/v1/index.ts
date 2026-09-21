import { Hono } from "hono";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { makeBadge } from "badge-maker";
import { getExtensionsDb } from "../../../lib/db";
import { ExtensionsDatabase } from "./database";
import { getLatestRelease, sortReleasesDescending } from "./interfaces";

const extensionsV1 = new Hono<{ Bindings: CloudflareBindings }>();

extensionsV1.use("/*", cors({ origin: "*" }));
extensionsV1.use("/*", trimTrailingSlash());

extensionsV1.get("/list", async (c) => {
  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));
  const type = c.req.query("type");

  // Opt-in pagination: absent params keep the exact original contract
  // (every published extension, no pagination object). A non-numeric limit
  // is treated as absent rather than a 400 - this legacy surface has never
  // validated query params.
  const limitParam = Number(c.req.query("limit"));
  const offsetParam = Number(c.req.query("offset") ?? "0");
  const page =
    Number.isInteger(limitParam) && limitParam >= 1 && limitParam <= 100
      ? {
          limit: limitParam,
          offset:
            Number.isInteger(offsetParam) && offsetParam >= 0 ? offsetParam : 0
        }
      : undefined;

  const { data, error } = await db.getAllExtensions(type, page);
  if (error) {
    return c.json({ error: { message: "Unable to load extensions" } }, 500);
  }

  return c.json({
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
});

extensionsV1.get("/:id/badges/:type", async (c) => {
  const id = c.req.param("id");
  const badgeType = c.req.param("type");

  const db = new ExtensionsDatabase(getExtensionsDb(c.env.DB_EXTENSIONS));

  const { data: extension, error } = await db.getExtensionById(id);
  if (error || !extension) {
    const status = error?.code === "NOT_FOUND" ? 404 : 500;
    return c.json(
      { error: { message: error?.message ?? "Extension not found" } },
      status
    );
  }

  const sorted = sortReleasesDescending(extension.releases);
  const latest = sorted[0];

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
      message: extension.license.name
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

  // Static import: wrangler's esbuild doesn't code-split, so a dynamic
  // import here would just be inlined back into the bundle.
  const svg = makeBadge(format);
  c.header("Content-Type", "image/svg+xml");
  return c.body(svg);
});

extensionsV1.get("/:id/version", async (c) => {
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

  const latest = getLatestRelease(extension);
  if (!latest) {
    return c.json({ error: { message: "No releases found" } }, 500);
  }

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

  return c.json({ result: extension });
});

export default extensionsV1;
