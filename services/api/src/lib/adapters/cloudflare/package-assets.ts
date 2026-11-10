import { PackageBuildDatabase } from "../../../services/extensions/v2/db/package-builds";
import { logError } from "@fossbilling/logging";
import { revalidateExtensions } from "../../../services/extensions/v2/revalidate";
import type { Context } from "hono";
import { getPlatform } from "../../middleware";
import { PackageError } from "@fossbilling/extension-packaging/errors";

// Publishing changes the listing URL only; icons are already stored in B2.
async function updatePublishedIconUrl(
  c: Context<{ Bindings: CloudflareBindings }>,
  extensionId: string
) {
  extensionId = extensionId.toLowerCase();
  const platform = getPlatform(c);
  const repository = new PackageBuildDatabase(c.env.DB_EXTENSIONS);
  const row = await repository.publishedIcon(extensionId);
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
  return repository.updatePublishedIcon(
    extensionId,
    row.published_revision_id,
    iconUrl
  );
}

export function schedulePublishedIconUpdate(
  c: Context<{ Bindings: CloudflareBindings }>,
  extensionId: string
) {
  if (!getPlatform(c).getEnv("EXTENSION_ASSETS_S3_ENDPOINT")) return;
  getPlatform(c).waitUntil(
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
