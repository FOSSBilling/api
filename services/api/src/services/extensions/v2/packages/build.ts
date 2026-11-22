import { PACKAGE_LIMITS } from "@fossbilling/extension-packaging/limits";
import { sha256 } from "@fossbilling/extension-packaging/checksum";
import {
  type PackageProcessor,
  type PackageSource,
  type PackageTarget
} from "@fossbilling/extension-packaging/processor";
import type { Manifest } from "../schemas/manifest";
import type {
  PackageRepository,
  PackageOwner,
  PackagePublisher,
  IconObject
} from "./repository";
import type { IconVariant } from "@fossbilling/extension-packaging/images";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import type { PackageStore } from "@fossbilling/extension-packaging/store";

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

export async function preparePackage(input: {
  repository: PackageRepository;
  store: PackageStore;
  owner: PackageOwner;
  target: PackageTarget;
  source: PackageSource;
  publisher: PackagePublisher | null;
  baseUrl: string;
  processor: PackageProcessor;
}) {
  const { repository, store, source: reference, target } = input;
  const objectId = crypto.randomUUID();
  await repository.reserveObject(
    input.owner,
    target.id ?? null,
    objectId,
    PACKAGE_LIMITS.sourceBytes
  );
  const prepared = await input.processor.process({
    target,
    source: reference,
    archive: objectId
  });
  const { manifest } = prepared;
  const owner = await repository.getOwner(
    input.owner.owner_user_id,
    manifest.id,
    input.publisher
  );
  if (
    owner.id !== input.owner.id ||
    owner.profile_generation !== input.owner.profile_generation ||
    owner.ownership_epoch !== input.owner.ownership_epoch
  )
    throw new PackageError(
      "FORBIDDEN",
      "Package ownership changed during validation",
      403
    );

  await repository.setObjectSize(objectId, prepared.archiveBytes);
  const existingSource = await repository.findSource(
    owner.profile_generation,
    manifest.id,
    manifest.version,
    reference.sha256
  );
  const existing = existingSource
    ? await repository.findArtifact(existingSource.id, reference.sha256)
    : null;
  if (
    !existing?.published_at &&
    (await repository.isPublishedVersion(manifest.id, manifest.version))
  )
    throw new PackageError(
      "RELEASE_PUBLISHED",
      "Published release ZIPs are locked; upload a new version",
      409
    );
  const source =
    existingSource ??
    (await repository.linkSource(owner, manifest, {
      id: crypto.randomUUID(),
      sha256: reference.sha256,
      object_id: objectId
    }));
  if (!source)
    throw new PackageError(
      "FORBIDDEN",
      "Package ownership changed during validation",
      403
    );

  const extensionId = await repository.ensureDraft(owner, manifest.id);
  await storePackageIcon({
    repository,
    extensionId,
    store,
    owner,
    manifest,
    sourceId: source.id,
    variants: prepared.icons
  });
  const artifactId = crypto.randomUUID();
  const downloadUrl = `${input.baseUrl}/packages/${artifactId}/download`;
  const artifact =
    existing ??
    (await repository.linkArtifact(owner, manifest, {
      id: artifactId,
      sourceId: source.id,
      sha256: reference.sha256,
      objectId: source.object_id,
      downloadUrl
    }));
  if (!artifact)
    throw new PackageError(
      "FORBIDDEN",
      "Ownership changed while preparing the package",
      403
    );
  if (source.object_id !== objectId) {
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
    const id = `extensions/${input.extensionId}/icons/${assetId}.${format}`;
    await repository.reserveObject(owner, manifest.id, id, bytes.length);
    const checksum = await sha256(bytes);
    await store.put(id, bytes, checksum);
    objects.push({ format, id, checksum });
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
