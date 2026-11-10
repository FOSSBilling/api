import { sha256 } from "@fossbilling/extension-packaging/checksum";
import {
  MAX_PACKAGE_OBJECT_BYTES,
  MAX_PACKAGE_ICON_BYTES,
  type PackageProcessor
} from "@fossbilling/extension-packaging/processor";
import type { Manifest } from "../schemas/manifest";
import { canonicalJson } from "./manifest";
import type { PackageRepository, PackageOwner, IconObject } from "./repository";
import type { IconVariant } from "@fossbilling/extension-packaging/images";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import {
  boundedBytes,
  type PackageStore
} from "@fossbilling/extension-packaging/store";

export async function reserveObject(
  repository: PackageRepository,
  store: PackageStore,
  owner: PackageOwner,
  identifier: string,
  bytes: Uint8Array<ArrayBuffer>,
  checksum: string,
  id: string = crypto.randomUUID()
) {
  await repository.reserveObject(owner, identifier, id, bytes.length);
  // Failed writes retain their reservation for later cleanup.
  await store.put(id, bytes, checksum);
  return id;
}
export async function cleanupPackageObjects(
  repository: PackageRepository,
  store: PackageStore
) {
  const ids = await repository.claimCleanup();
  for (const id of ids) {
    await store.delete(id);
    await repository.finishCleanup(id);
  }
  return ids.length;
}

export async function buildStoredPackage(input: {
  repository: PackageRepository;
  store: PackageStore;
  owner: PackageOwner;
  manifest: Manifest;
  upload?: { sha256: string; objectId: string };
  sourceId?: string;
  baseUrl: string;
  processor: PackageProcessor;
}) {
  const { repository, store, owner, manifest } = input;
  let source = await repository.findSource(
    owner.profile_generation,
    manifest.id,
    manifest.version
  );
  if (input.sourceId && source?.id !== input.sourceId)
    throw new PackageError(
      "NOT_FOUND",
      "Source not found for this extension version",
      404
    );
  if (input.upload && source && input.upload.sha256 !== source.sha256)
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
    const existing = await repository.findArtifact(source.id, manifestHash);
    if (existing) return existing;
  }
  const upload =
    input.upload ??
    (source ? { objectId: source.object_id, sha256: source.sha256 } : null);
  if (!upload) throw new PackageError("NOT_FOUND", "Source ZIP not found", 404);
  const prepared = source && (await repository.hasIcon(source.id));
  const objectId = crypto.randomUUID();
  const iconIds: [string, string] | undefined = prepared
    ? undefined
    : [crypto.randomUUID(), crypto.randomUUID()];
  // Reserve worst-case output space before an external runner can write to B2.
  // Unused/failed reservations remain discoverable by the normal cleanup job.
  await repository.reserveObject(
    owner,
    manifest.id,
    objectId,
    MAX_PACKAGE_OBJECT_BYTES
  );
  for (const id of iconIds ?? [])
    await repository.reserveObject(
      owner,
      manifest.id,
      id,
      MAX_PACKAGE_ICON_BYTES
    );
  const built = await input.processor.process({
    manifest,
    source: { id: upload.objectId, sha256: upload.sha256 },
    archive: objectId,
    icons: iconIds
  });
  await repository.setObjectSize(objectId, built.archive.bytes);
  const variants: IconVariant[] = [];
  for (const icon of built.icons) {
    const bytes = await boundedBytes(
      await store.get(icon.id, icon.sha256),
      MAX_PACKAGE_ICON_BYTES
    );
    if (bytes.length !== icon.bytes || (await sha256(bytes)) !== icon.sha256)
      throw new PackageError(
        "PACKAGE_UNAVAILABLE",
        "Prepared icon failed checksum verification",
        503
      );
    variants.push({ format: icon.format, bytes });
  }
  if (!source) {
    source = await repository.linkSource(owner, manifest, {
      id: crypto.randomUUID(),
      sha256: upload.sha256,
      object_id: upload.objectId
    });
    if (!source)
      throw new PackageError(
        "FORBIDDEN",
        "Ownership changed while building",
        403
      );
    if (source.sha256 !== upload.sha256)
      throw new PackageError(
        "SOURCE_CHANGED",
        "Another upload reserved this version with different source files",
        409
      );
  }

  const extensionId = await repository.ensureDraft(owner, manifest.id);
  await storePackageIcon({
    repository,
    extensionId,
    store,
    owner,
    manifest,
    sourceId: source.id,
    variants
  });
  const artifactId = crypto.randomUUID();
  const downloadUrl = `${input.baseUrl}/packages/${artifactId}/download`;
  const artifact = await repository.linkArtifact(owner, manifest, {
    id: artifactId,
    sourceId: source.id,
    manifestHash,
    sha256: built.archive.sha256,
    objectId,
    downloadUrl
  });
  if (!artifact)
    throw new PackageError(
      "FORBIDDEN",
      "Ownership changed while building",
      403
    );
  if (artifact.object_id !== objectId) {
    await store.delete(objectId);
    await repository.removeObject(objectId);
  }
  for (const id of iconIds ?? []) {
    await store.delete(id);
    await repository.removeObject(id);
  }
  return artifact;
}

async function storePackageIcon(input: {
  extensionId: string;
  repository: PackageRepository;
  store: PackageStore;
  owner: PackageOwner;
  manifest: Manifest;
  sourceId: string;
  variants: IconVariant[];
}) {
  const { repository, store, owner, manifest, sourceId, variants } = input;
  if (await repository.hasIcon(sourceId)) return;
  const assetId = crypto.randomUUID();
  const objects: IconObject[] = [];
  for (const { format, bytes } of variants) {
    const checksum = await sha256(bytes);
    objects.push({
      format,
      id: await reserveObject(
        repository,
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
  const linked = await repository.linkIcon(
    owner,
    manifest.id,
    sourceId,
    objects
  );
  if (!linked) {
    for (const object of objects) {
      await store.delete(object.id);
      await repository.removeObject(object.id);
    }
    if (!(await repository.hasIcon(sourceId)))
      throw new PackageError(
        "FORBIDDEN",
        "Ownership changed while processing icon",
        403
      );
  }
}
