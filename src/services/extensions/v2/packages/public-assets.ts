import { logError } from "../../../../lib/logger";
import { revalidateExtensions } from "../revalidate";
import type { Context } from "hono";
import { getPlatform } from "../../../../lib/middleware";
import { PackageError } from "./errors";

// Publishing changes the listing URL only; icons are already stored in B2.
async function updatePublishedIconUrl(
  c: Context<{ Bindings: CloudflareBindings }>,
  extensionId: string
) {
  extensionId = extensionId.toLowerCase();
  const platform = getPlatform(c);
  const row = await c.env.DB_EXTENSIONS.prepare(
    `
    SELECT e.published_revision_id, coalesce(i.svg_object_id,i.png_object_id) AS object_key
    FROM extensions e
    JOIN package_artifacts a ON a.download_url=e.download_url AND a.published_at IS NOT NULL
    JOIN package_sources s ON s.id=a.source_id AND s.extension_identifier=lower(e.identifier)
    JOIN package_icons i ON i.source_id=s.id
    WHERE lower(e.identifier)=? AND e.published_at IS NOT NULL AND e.delisted_at IS NULL
  `
  )
    .bind(extensionId)
    .first<{ published_revision_id: string; object_key: string | null }>();
  if (!row?.object_key) return;
  const base = platform.getEnv("EXTENSION_ASSETS_PUBLIC_URL");
  if (!base)
    throw new PackageError(
      "ASSETS_UNAVAILABLE",
      "Public asset URL is not configured",
      503
    );
  const publicBase = new URL(base);
  if (
    publicBase.protocol !== "https:" ||
    publicBase.username ||
    publicBase.password ||
    publicBase.search ||
    publicBase.hash
  )
    throw new PackageError(
      "ASSETS_UNAVAILABLE",
      "Invalid public asset URL",
      503
    );
  const iconUrl = `${publicBase.href.replace(/\/$/, "")}/${row.object_key}`;
  const updated = await c.env.DB_EXTENSIONS.prepare(
    "UPDATE extensions SET icon_url=? WHERE lower(identifier)=? AND published_revision_id=? AND delisted_at IS NULL AND icon_url IS NOT ?"
  )
    .bind(iconUrl, extensionId, row.published_revision_id, iconUrl)
    .run();
  return Boolean(updated.meta.changes);
}

export function schedulePublishedIconUpdate(
  c: Context<{ Bindings: CloudflareBindings }>,
  extensionId: string
) {
  if (!getPlatform(c).getEnv("EXTENSION_ASSETS_S3_ENDPOINT")) return;
  c.executionCtx.waitUntil(
    updatePublishedIconUrl(c, extensionId)
      .then((changed) => {
        if (changed) revalidateExtensions(c);
      })
      .catch((error) => {
        logError("extensions/packages", "Published icon URL update failed", {
          extensionId,
          error: error instanceof Error ? error.message : String(error)
        });
      })
  );
}
