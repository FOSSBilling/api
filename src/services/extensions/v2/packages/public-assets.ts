import { logError } from "../../../../lib/logger";
import { revalidateExtensions } from "../revalidate";
import type { ExtensionContent } from "../schemas/extensions";
import { sha256 } from "../package-builder";
import { AwsClient } from "aws4fetch";
import type { Context } from "hono";
import { getPlatform } from "../../../../lib/middleware";
import { ARTIFACT_SELECT, type ArtifactRow } from "../db/packages";
import { latestRelease } from "../../../../lib/releases";
import { PackageError } from "./errors";
import { boundedBytes, packageStore } from "./store";

// Only called for committed, published content. Uploads and pending previews
// always use the private image bucket, even when B2 is configured.
export async function publishExtensionIcon(
  c: Context<{ Bindings: CloudflareBindings }>,
  extensionId: string
) {
  extensionId = extensionId.toLowerCase();
  const platform = getPlatform(c);
  const endpoint = platform.getEnv("EXTENSION_ASSETS_S3_ENDPOINT");
  if (!endpoint) return;
  const get = (name: string) => {
    const value = platform.getEnv(`EXTENSION_ASSETS_${name}`);
    if (!value)
      throw new PackageError(
        "ASSETS_UNAVAILABLE",
        "Asset storage configuration is incomplete",
        503
      );
    return value;
  };
  const row = await c.env.DB_EXTENSIONS.prepare(
    "SELECT releases,published_revision_id FROM extensions WHERE id=? AND published_at IS NOT NULL AND delisted_at IS NULL"
  )
    .bind(extensionId)
    .first<{ releases: string; published_revision_id: string }>();
  if (!row) return;
  const latest = latestRelease(
    JSON.parse(row.releases) as ExtensionContent["releases"]
  );
  if (!latest?.artifact_id) return;
  const artifact = await c.env.DB_EXTENSIONS.prepare(
    `${ARTIFACT_SELECT} WHERE a.id=? AND a.published_at IS NOT NULL AND s.extension_id=?`
  )
    .bind(latest.artifact_id, extensionId)
    .first<ArtifactRow>();
  if (
    !artifact?.icon_source_id ||
    (!artifact.svg_object_id && !artifact.png_object_id)
  )
    return;
  const store = packageStore(c);
  if (!store) return;
  const origin = new URL(endpoint);
  const publicBase = new URL(get("PUBLIC_URL"));
  if (
    origin.protocol !== "https:" ||
    publicBase.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    publicBase.username ||
    publicBase.password ||
    origin.search ||
    publicBase.search ||
    origin.hash ||
    publicBase.hash ||
    origin.pathname !== "/"
  )
    throw new PackageError(
      "ASSETS_UNAVAILABLE",
      "Asset storage URLs must use HTTPS without credentials or query parameters",
      503
    );
  const bucket = get("S3_BUCKET");
  if (!/^[a-zA-Z0-9-]+$/.test(bucket))
    throw new PackageError(
      "ASSETS_UNAVAILABLE",
      "Invalid asset bucket name",
      503
    );
  const prefix = platform.getEnv("EXTENSION_ASSETS_S3_PREFIX") ?? "local";
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix))
    throw new PackageError("ASSETS_UNAVAILABLE", "Invalid asset prefix", 503);
  const aws = new AwsClient({
    accessKeyId: get("S3_ACCESS_KEY_ID"),
    secretAccessKey: get("S3_SECRET_ACCESS_KEY"),
    region: get("S3_REGION"),
    service: "s3",
    retries: 0
  });
  const identity =
    artifact.svg_sha256 ??
    (await sha256(
      new Uint8Array(
        new TextEncoder().encode(
          `${artifact.avif_sha256}:${artifact.png_sha256}`
        )
      )
    ));
  let iconUrl: string | undefined;
  for (const format of artifact.svg_object_id
    ? (["svg"] as const)
    : (["avif", "png"] as const)) {
    const key = artifact[`${format}_object_id`];
    const checksum = artifact[`${format}_sha256`];
    if (!key || !checksum)
      throw new PackageError(
        "ASSETS_UNAVAILABLE",
        "Prepared asset is unavailable",
        503
      );
    const objectKey = `${prefix}/icons/${identity}.${format}`;
    const url = new URL(`${publicBase.href.replace(/\/$/, "")}/${objectKey}`)
      .href;
    const contentType = format === "svg" ? "image/svg+xml" : `image/${format}`;
    const cacheKey = `extension-asset:${url}`;
    if (!(await c.env.CACHE_KV.get(cacheKey))) {
      const target = new URL(`/${bucket}/${objectKey}`, origin);
      const head = await fetch(
        await aws.sign(target, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(5000)
        })
      );
      if (
        head.status !== 404 &&
        (!head.ok || head.headers.get("x-amz-meta-sha256") !== checksum)
      ) {
        await head.body?.cancel();
        throw new PackageError(
          "ASSETS_UNAVAILABLE",
          "Unable to verify public asset storage",
          503
        );
      }
      if (head.status === 404) {
        const bytes = await boundedBytes(
          await store.get(key, checksum),
          4 * 1024 * 1024
        );
        if (!bytes.length)
          throw new PackageError(
            "ASSETS_UNAVAILABLE",
            "Prepared asset is unavailable",
            503
          );
        const response = await fetch(
          await aws.sign(target, {
            method: "PUT",
            body: bytes,
            redirect: "manual",
            signal: AbortSignal.timeout(5000),
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=31536000, immutable",
              "x-amz-content-sha256": checksum,
              "x-amz-meta-sha256": checksum
            }
          })
        );
        await response.body?.cancel();
        if (!response.ok)
          throw new PackageError(
            "ASSETS_UNAVAILABLE",
            "Public asset upload failed",
            503
          );
      }
      await head.body?.cancel();
      await c.env.CACHE_KV.put(cacheKey, "ready", { expirationTtl: 86400 });
    }
    // PNG is the fallback URL; the directory offers its AVIF sibling via <picture>.
    if (format !== "avif") iconUrl = url;
  }
  if (iconUrl) {
    const updated = await c.env.DB_EXTENSIONS.prepare(
      "UPDATE extensions SET icon_url=? WHERE id=? AND published_revision_id=? AND delisted_at IS NULL AND icon_url IS NOT ?"
    )
      .bind(iconUrl, extensionId, row.published_revision_id, iconUrl)
      .run();
    return Boolean(updated.meta.changes);
  }
}

export function scheduleIconPublication(
  c: Context<{ Bindings: CloudflareBindings }>,
  extensionId: string
) {
  if (!getPlatform(c).getEnv("EXTENSION_ASSETS_S3_ENDPOINT")) return;
  c.executionCtx.waitUntil(
    publishExtensionIcon(c, extensionId)
      .then((changed) => {
        if (changed) revalidateExtensions(c);
      })
      .catch((error) => {
        logError("extensions/packages", "Icon publication failed", {
          extensionId,
          error: error instanceof Error ? error.message : String(error)
        });
      })
  );
}
