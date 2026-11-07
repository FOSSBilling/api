import { v7 as uuidv7 } from "uuid";
import type { PublisherContext } from "../middleware";
import { sanitizeSvg } from "@zeropress/svg-hush/workerd";
import {
  buildExtensionPackage,
  PACKAGE_LIMITS,
  sha256
} from "../package-builder";
import { Manifest } from "../schemas/manifest";
import { ARTIFACT_SELECT, ArtifactRow, canonicalJson } from "../db/packages";
import { PackageError } from "./errors";
import { boundedBytes, PackageStore } from "./store";

export interface PackageOwner {
  id: string;
  profile_generation: string;
  ownership_epoch: number;
  owner_user_id: string;
  publisher_client_id?: string;
}
interface SourceRow {
  id: string;
  sha256: string;
  object_id: string;
}
export const MAX_PACKAGE_STORAGE_BYTES = 512 * 1024 * 1024;
export const MAX_PACKAGE_OBJECTS = 256;

function ownerPredicate() {
  return `EXISTS (SELECT 1 FROM developers d JOIN users u ON u.id=d.owner_user_id WHERE d.id=? AND d.profile_generation=? AND d.ownership_epoch=? AND d.owner_user_id=? AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM extensions e WHERE lower(e.identifier)=lower(?) AND e.developer_id!=d.id) AND (? IS NULL OR EXISTS (SELECT 1 FROM m2m_publisher_clients p WHERE p.client_id=? AND p.developer_id=d.id AND p.ownership_epoch=d.ownership_epoch AND p.revoked_at IS NULL)))`;
}
function ownerParams(owner: PackageOwner, id: string) {
  return [
    owner.id,
    owner.profile_generation,
    owner.ownership_epoch,
    owner.owner_user_id,
    id,
    owner.publisher_client_id ?? null,
    owner.publisher_client_id ?? null
  ];
}

export async function packageOwner(
  db: D1Database,
  userId: string,
  extensionId: string,
  publisher?: PublisherContext | null
) {
  const owner = await db
    .prepare(
      `SELECT d.id,d.profile_generation,d.ownership_epoch,d.owner_user_id FROM developers d JOIN users u ON u.id=d.owner_user_id WHERE (? IS NULL AND d.owner_user_id=? OR d.id=? AND d.ownership_epoch=? AND EXISTS (SELECT 1 FROM m2m_publisher_clients p WHERE p.client_id=? AND p.developer_id=d.id AND p.ownership_epoch=d.ownership_epoch AND p.revoked_at IS NULL)) AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM extensions e WHERE lower(e.identifier)=lower(?) AND e.developer_id!=d.id)`
    )
    .bind(
      publisher?.clientId ?? null,
      userId,
      publisher?.developerId ?? null,
      publisher?.ownershipEpoch ?? null,
      publisher?.clientId ?? null,
      extensionId
    )
    .first<PackageOwner>();
  if (!owner)
    throw new PackageError(
      "FORBIDDEN",
      "An active owning developer profile is required",
      403
    );
  return { ...owner, publisher_client_id: publisher?.clientId };
}

export async function reserveObject(
  db: D1Database,
  store: PackageStore,
  owner: PackageOwner,
  extensionId: string,
  bytes: Uint8Array<ArrayBuffer>,
  checksum: string,
  id: string = crypto.randomUUID()
) {
  const result = await db
    .prepare(
      `INSERT INTO package_objects (id,created_by,bytes)
    SELECT ?,?,? WHERE ${ownerPredicate()}
    AND (SELECT count(*) FROM package_objects WHERE created_by=?) < ?
    AND (SELECT coalesce(sum(bytes),0) FROM package_objects WHERE created_by=?) + ? <= ?`
    )
    .bind(
      id,
      owner.owner_user_id,
      bytes.length,
      ...ownerParams(owner, extensionId),
      owner.owner_user_id,
      MAX_PACKAGE_OBJECTS,
      owner.owner_user_id,
      bytes.length,
      MAX_PACKAGE_STORAGE_BYTES
    )
    .run();
  if (!result.meta.changes)
    throw new PackageError(
      "PACKAGE_ADMISSION",
      "Ownership changed or package storage quota is exhausted",
      409
    );
  // A reservation is retained on failure/interruption for safe later cleanup.
  await store.put(id, bytes, checksum);
  return id;
}

export async function cleanupPackageObjects(
  db: D1Database,
  store: PackageStore
) {
  const result = await db
    .prepare(
      `UPDATE package_objects SET deleting=1 WHERE id IN (
    SELECT o.id FROM package_objects o WHERE (o.deleting=1 OR o.created_at < datetime('now','-1 day'))
    AND NOT EXISTS (SELECT 1 FROM package_jobs j WHERE j.upload_object_id=o.id AND j.status IN ('queued','processing'))
    AND NOT EXISTS (SELECT 1 FROM package_sources s WHERE s.object_id=o.id)
    AND NOT EXISTS (SELECT 1 FROM package_artifacts a WHERE a.object_id=o.id)
    AND NOT EXISTS (SELECT 1 FROM package_icons i WHERE i.avif_object_id=o.id OR i.png_object_id=o.id OR i.svg_object_id=o.id) LIMIT 100
  ) RETURNING id`
    )
    .all<{ id: string }>();
  for (const { id } of result.results) {
    await store.delete(id);
    await db
      .prepare(
        "UPDATE package_jobs SET upload_object_id=NULL WHERE upload_object_id=? AND status IN ('ready','failed')"
      )
      .bind(id)
      .run();
    await db
      .prepare("DELETE FROM package_objects WHERE id=? AND deleting=1")
      .bind(id)
      .run();
  }
  return result.results.length;
}

export async function buildStoredPackage(input: {
  db: D1Database;
  store: PackageStore;
  owner: PackageOwner;
  manifest: Manifest;
  source?: Uint8Array<ArrayBuffer>;
  sourceObjectId?: string;
  sourceId?: string;
  baseUrl: string;
  images?: ImagesBinding;
}) {
  const { db, store, owner, manifest } = input;
  let source = await db
    .prepare(
      "SELECT id,sha256,object_id FROM package_sources WHERE profile_generation=? AND extension_identifier=? AND version=?"
    )
    .bind(owner.profile_generation, manifest.id, manifest.version)
    .first<SourceRow>();
  if (input.sourceId && source?.id !== input.sourceId)
    throw new PackageError(
      "NOT_FOUND",
      "Source not found for this extension version",
      404
    );
  let sourceBytes = input.source;
  if (sourceBytes && source && (await sha256(sourceBytes)) !== source.sha256)
    throw new PackageError(
      "SOURCE_CHANGED",
      "This version already has a different source ZIP; use a new extension version",
      409
    );
  const manifestJson = canonicalJson(manifest);
  const manifestHash = await sha256(
    new Uint8Array(new TextEncoder().encode(manifestJson))
  );
  if (source) {
    const existing = await db
      .prepare(`${ARTIFACT_SELECT} WHERE a.source_id=? AND a.manifest_hash=?`)
      .bind(source.id, manifestHash)
      .first<ArtifactRow>();
    if (existing) return existing;
  }
  if (!sourceBytes) {
    if (!source)
      throw new PackageError("NOT_FOUND", "Source ZIP not found", 404);
    sourceBytes = await boundedBytes(
      await store.get(source.object_id),
      PACKAGE_LIMITS.sourceBytes
    );
    if ((await sha256(sourceBytes)) !== source.sha256)
      throw new PackageError(
        "SOURCE_UNAVAILABLE",
        "Stored source failed checksum verification",
        503
      );
  }
  let built;
  try {
    built = await buildExtensionPackage(sourceBytes, manifest);
  } catch {
    throw new PackageError(
      "INVALID_PACKAGE",
      "Source ZIP failed package validation",
      422
    );
  }
  const prepared =
    source &&
    (await db
      .prepare("SELECT 1 FROM package_icons WHERE source_id=?")
      .bind(source.id)
      .first());
  const variants = prepared
    ? []
    : await optimizePackageIcon(
        built.icon,
        input.images,
        built.iconName === "icon.svg"
      );
  if (!source) {
    const objectId =
      input.sourceObjectId ??
      (await reserveObject(
        db,
        store,
        owner,
        manifest.id,
        sourceBytes,
        built.sourceSha256
      ));
    const sourceId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO package_sources (id,profile_generation,extension_identifier,version,sha256,object_id)
      SELECT ?,?,?,?,?,? WHERE ${ownerPredicate()} AND EXISTS (SELECT 1 FROM package_objects WHERE id=? AND deleting=0)
      ON CONFLICT DO NOTHING`
      )
      .bind(
        sourceId,
        owner.profile_generation,
        manifest.id,
        manifest.version,
        built.sourceSha256,
        objectId,
        ...ownerParams(owner, manifest.id),
        objectId
      )
      .run();
    source = await db
      .prepare(
        "SELECT id,sha256,object_id FROM package_sources WHERE profile_generation=? AND extension_identifier=? AND version=?"
      )
      .bind(owner.profile_generation, manifest.id, manifest.version)
      .first<SourceRow>();
    if (!source)
      throw new PackageError(
        "FORBIDDEN",
        "Ownership changed while building",
        403
      );
    if (source.object_id !== objectId) {
      if (!input.sourceObjectId) {
        await store.delete(objectId);
        await db
          .prepare("DELETE FROM package_objects WHERE id=?")
          .bind(objectId)
          .run();
      }
      if (source.sha256 !== built.sourceSha256)
        throw new PackageError(
          "SOURCE_CHANGED",
          "Another upload reserved this version with different source files",
          409
        );
    }
  }
  // Reserve the permanent identity only after ZIP and icon validation succeeds.
  await db
    .prepare(
      `INSERT INTO extensions (id,identifier,developer_id,created_by)
    SELECT ?,?,?,? WHERE ${ownerPredicate()} ON CONFLICT DO NOTHING`
    )
    .bind(
      uuidv7(),
      manifest.id,
      owner.id,
      owner.owner_user_id,
      ...ownerParams(owner, manifest.id)
    )
    .run();
  const extension = await db
    .prepare(
      "SELECT id FROM extensions WHERE lower(identifier)=lower(?) AND developer_id=?"
    )
    .bind(manifest.id, owner.id)
    .first<{ id: string }>();
  if (!extension)
    throw new PackageError(
      "FORBIDDEN",
      "Extension ownership changed while preparing the package",
      403
    );
  await storePackageIcon({
    db,
    extensionId: extension.id,
    store,
    owner,
    manifest,
    sourceId: source.id,
    variants
  });
  const objectId = await reserveObject(
    db,
    store,
    owner,
    manifest.id,
    built.bytes,
    built.packageSha256
  );
  const artifactId = crypto.randomUUID();
  const downloadUrl = `${input.baseUrl}/packages/${artifactId}/download`;
  await db
    .prepare(
      `INSERT INTO package_artifacts (id,source_id,manifest,manifest_hash,sha256,object_id,download_url)
    SELECT ?,?,?,?,?,?,? WHERE ${ownerPredicate()} AND EXISTS (SELECT 1 FROM package_objects WHERE id=? AND deleting=0)
    ON CONFLICT DO NOTHING`
    )
    .bind(
      artifactId,
      source.id,
      manifestJson,
      manifestHash,
      built.packageSha256,
      objectId,
      downloadUrl,
      ...ownerParams(owner, manifest.id),
      objectId
    )
    .run();
  const artifact = await db
    .prepare(`${ARTIFACT_SELECT} WHERE a.source_id=? AND a.manifest_hash=?`)
    .bind(source.id, manifestHash)
    .first<ArtifactRow>();
  if (!artifact)
    throw new PackageError(
      "FORBIDDEN",
      "Ownership changed while building",
      403
    );
  if (artifact.object_id !== objectId) {
    await store.delete(objectId);
    await db
      .prepare("DELETE FROM package_objects WHERE id=?")
      .bind(objectId)
      .run();
  }
  return artifact;
}

async function storePackageIcon(input: {
  extensionId: string;
  db: D1Database;
  store: PackageStore;
  owner: PackageOwner;
  manifest: Manifest;
  sourceId: string;
  variants: IconVariant[];
}) {
  const { db, store, owner, manifest, sourceId, variants } = input;
  if (
    await db
      .prepare("SELECT 1 FROM package_icons WHERE source_id=?")
      .bind(sourceId)
      .first()
  )
    return;
  const assetId = crypto.randomUUID();
  const objects: {
    format: IconVariant["format"];
    id: string;
    checksum: string;
  }[] = [];
  for (const { format, bytes } of variants) {
    const checksum = await sha256(bytes);
    objects.push({
      format,
      id: await reserveObject(
        db,
        store,
        owner,
        manifest.id,
        bytes,
        checksum,
        `extensions/${input.extensionId}/icons/${assetId}.${format}`
      ),
      checksum
    });
  }
  const avif = objects.find((object) => object.format === "avif");
  const png = objects.find((object) => object.format === "png");
  const svg = objects.find((object) => object.format === "svg");
  const result = await db
    .prepare(
      `INSERT INTO package_icons (source_id,avif_object_id,avif_sha256,png_object_id,png_sha256,svg_object_id,svg_sha256)
    SELECT ?,?,?,?,?,?,? WHERE ${ownerPredicate()}
    AND NOT EXISTS (SELECT 1 FROM package_objects WHERE id IN (?,?,?) AND deleting=1)
    ON CONFLICT DO NOTHING`
    )
    .bind(
      sourceId,
      avif?.id ?? null,
      avif?.checksum ?? null,
      png?.id ?? null,
      png?.checksum ?? null,
      svg?.id ?? null,
      svg?.checksum ?? null,
      ...ownerParams(owner, manifest.id),
      avif?.id ?? null,
      png?.id ?? null,
      svg?.id ?? null
    )
    .run();
  if (!result.meta.changes) {
    for (const object of objects) {
      await store.delete(object.id);
      await db
        .prepare("DELETE FROM package_objects WHERE id=?")
        .bind(object.id)
        .run();
    }
    if (
      !(await db
        .prepare("SELECT 1 FROM package_icons WHERE source_id=?")
        .bind(sourceId)
        .first())
    )
      throw new PackageError(
        "FORBIDDEN",
        "Ownership changed while processing icon",
        403
      );
  }
}

type IconVariant = {
  format: "avif" | "png" | "svg";
  bytes: Uint8Array<ArrayBuffer>;
};
async function optimizePackageIcon(
  icon: Uint8Array<ArrayBuffer> | null,
  images?: ImagesBinding,
  isSvg = false
): Promise<IconVariant[]> {
  if (!icon) return [];
  if (isSvg) {
    try {
      return [{ format: "svg", bytes: new Uint8Array(sanitizeSvg(icon)) }];
    } catch {
      throw new PackageError(
        "INVALID_ICON",
        "Package SVG icon could not be sanitized",
        422
      );
    }
  }
  if (!images)
    throw new PackageError(
      "PACKAGES_DISABLED",
      "Image processing is not configured",
      503
    );
  const variants: IconVariant[] = [];
  try {
    const info = await images.info(new Blob([icon]).stream());
    // Check decoded format too: a misleading filename must not bypass sanitization.
    if (info.format === "image/svg+xml")
      return [{ format: "svg", bytes: new Uint8Array(sanitizeSvg(icon)) }];
    for (const format of ["avif", "png"] as const) {
      const output = await images
        .input(new Blob([icon]).stream())
        .transform({
          width: 256,
          height: 256,
          fit: "scale-down"
        })
        .output({ format: `image/${format}`, anim: false });
      variants.push({
        format,
        bytes: await boundedBytes(output.image(), 1024 * 1024)
      });
    }
  } catch {
    throw new PackageError(
      "INVALID_ICON",
      "Package icon could not be processed",
      422
    );
  }
  return variants;
}
