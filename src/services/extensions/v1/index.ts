import { Hono } from "hono";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { makeBadge } from "badge-maker";
import { getPlatform } from "../../../lib/middleware";
import { ExtensionsDatabase } from "./database";
import { getLatestRelease, sortReleasesDescending } from "./interfaces";

const extensionsV1 = new Hono<{ Bindings: CloudflareBindings }>();

extensionsV1.use("/*", cors({ origin: "*" }));
extensionsV1.use("/*", trimTrailingSlash());

extensionsV1.get("/list", async (c) => {
  const platform = getPlatform(c);
  const db = new ExtensionsDatabase(platform.getDatabase("DB_EXTENSIONS"));
  const type = c.req.query("type");

  const { data, error } = await db.getAllExtensions(type);
  if (error) {
    return c.json({ error: { message: "Unable to load extensions" } }, 500);
  }

  return c.json({ result: data });
});

extensionsV1.get("/:id/badges/:type", async (c) => {
  const id = c.req.param("id");
  const badgeType = c.req.param("type");

  const platform = getPlatform(c);
  const db = new ExtensionsDatabase(platform.getDatabase("DB_EXTENSIONS"));

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

  const svg = makeBadge(format);
  c.header("Content-Type", "image/svg+xml");
  return c.body(svg);
});

extensionsV1.get("/:id/version", async (c) => {
  const id = c.req.param("id");

  const platform = getPlatform(c);
  const db = new ExtensionsDatabase(platform.getDatabase("DB_EXTENSIONS"));

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

  const platform = getPlatform(c);
  const db = new ExtensionsDatabase(platform.getDatabase("DB_EXTENSIONS"));

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
