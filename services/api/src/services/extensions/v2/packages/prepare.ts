import type { PackageRepository } from "./repository";
import type { PackageProcessor } from "@fossbilling/extension-packaging/processor";
import type { PackageStore } from "@fossbilling/extension-packaging/store";
import type { PackagingJob } from "./jobs";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import { buildStoredPackage } from "./build";

export interface PackagePreparation {
  repository: PackageRepository;
  store: PackageStore;
  processor: PackageProcessor;
  baseUrl: string;
}

export async function prepareQueuedPackage(
  services: PackagePreparation,
  job: PackagingJob
): Promise<string> {
  const { repository, store } = services;
  const previous = job.owner;
  const current = await repository.getOwner(
    previous.owner_user_id,
    job.manifest.id,
    previous.publisher_client_id
      ? {
          clientId: previous.publisher_client_id,
          developerId: previous.id,
          ownershipEpoch: previous.ownership_epoch
        }
      : null
  );
  if (
    current.id !== previous.id ||
    current.profile_generation !== previous.profile_generation ||
    current.ownership_epoch !== previous.ownership_epoch
  )
    throw new PackageError(
      "FORBIDDEN",
      "Package ownership changed while queued",
      403
    );
  const upload =
    job.uploadObjectId && job.uploadSha256
      ? { objectId: job.uploadObjectId, sha256: job.uploadSha256 }
      : undefined;
  const artifact = await buildStoredPackage({
    repository,
    store,
    owner: current,
    manifest: job.manifest,
    upload,
    sourceId: job.sourceId ?? undefined,
    baseUrl: services.baseUrl.replace(/\/$/, ""),
    processor: services.processor
  });
  return artifact.id;
}
