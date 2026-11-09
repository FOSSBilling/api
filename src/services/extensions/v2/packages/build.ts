import {
  buildExtensionPackage,
  PACKAGE_LIMITS,
  sha256
} from "../package-builder";
import type { Manifest } from "../schemas/manifest";
import { canonicalJson } from "./manifest";
import type { PackageRepository, PackageOwner, IconObject } from "./repository";
import type { PackageImageProcessor, IconVariant } from "./images";
import { PackageError } from "./errors";
import { boundedBytes, type PackageStore } from "./store";

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
  source?: Uint8Array<ArrayBuffer>;
  sourceObjectId?: string;
  sourceId?: string;
  baseUrl: string;
  images: PackageImageProcessor;
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
    const existing = await repository.findArtifact(source.id, manifestHash);
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
  const prepared = source && (await repository.hasIcon(source.id));
  const variants =
    prepared || !built.icon
      ? []
      : await input.images.prepare(built.icon, built.iconName === "icon.svg");
  if (!source) {
    const objectId =
      input.sourceObjectId ??
      (await reserveObject(
        repository,
        store,
        owner,
        manifest.id,
        sourceBytes,
        built.sourceSha256
      ));
    source = await repository.linkSource(owner, manifest, {
      id: crypto.randomUUID(),
      sha256: built.sourceSha256,
      object_id: objectId
    });
    if (!source)
      throw new PackageError(
        "FORBIDDEN",
        "Ownership changed while building",
        403
      );
    if (source.object_id !== objectId) {
      if (!input.sourceObjectId) {
        await store.delete(objectId);
        await repository.removeObject(objectId);
      }
      if (source.sha256 !== built.sourceSha256)
        throw new PackageError(
          "SOURCE_CHANGED",
          "Another upload reserved this version with different source files",
          409
        );
    }
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
  const objectId = await reserveObject(
    repository,
    store,
    owner,
    manifest.id,
    built.bytes,
    built.packageSha256
  );
  const artifactId = crypto.randomUUID();
  const downloadUrl = `${input.baseUrl}/packages/${artifactId}/download`;
  const artifact = await repository.linkArtifact(owner, manifest, {
    id: artifactId,
    sourceId: source.id,
    manifestHash,
    sha256: built.packageSha256,
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
