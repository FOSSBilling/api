import type { PackageRepository } from "./repository";
import type { PackageProcessor } from "@fossbilling/extension-packaging/processor";
import type { PackageStore } from "@fossbilling/extension-packaging/store";
import type { PackagingJob } from "./jobs";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import { prepareStoredPackage } from "./build";

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
  const publisher = previous.publisher_client_id
    ? {
        clientId: previous.publisher_client_id,
        developerId: previous.id,
        ownershipEpoch: previous.ownership_epoch
      }
    : null;
  const current = await repository.getOwner(
    previous.owner_user_id,
    job.target.id ?? null,
    publisher
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
  if (!job.uploadObjectId || !job.uploadSha256)
    throw new PackageError("UPLOAD_NOT_FOUND", "Package upload not found", 404);
  const artifact = await prepareStoredPackage({
    repository,
    store,
    owner: current,
    target: job.target,
    upload: { objectId: job.uploadObjectId, sha256: job.uploadSha256 },
    publisher,
    baseUrl: services.baseUrl.replace(/\/$/, ""),
    processor: services.processor
  });
  return artifact.id;
}
