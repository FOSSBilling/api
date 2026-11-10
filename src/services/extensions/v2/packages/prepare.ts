import type { PackageRepository } from "./repository";
import type { PackageImageProcessor } from "./images";
import type { PackageStore } from "./store";
import type { PackageJob } from "./jobs";
import { PackageError } from "./errors";
import { boundedBytes } from "./store";
import { buildStoredPackage } from "./build";
import { PACKAGE_LIMITS } from "../package-builder";

export interface PackagePreparation {
  repository: PackageRepository;
  store: PackageStore;
  images: PackageImageProcessor;
  baseUrl: string;
}

export async function prepareQueuedPackage(
  services: PackagePreparation,
  job: PackageJob
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
  let upload: { bytes: Uint8Array<ArrayBuffer>; objectId: string } | undefined;
  if (job.uploadObjectId) {
    const body = await store.get(
      job.uploadObjectId,
      job.uploadSha256 ?? undefined
    );
    if (!body)
      throw new PackageError(
        "SOURCE_UNAVAILABLE",
        "Queued source ZIP is unavailable",
        503
      );
    upload = {
      bytes: await boundedBytes(body, PACKAGE_LIMITS.sourceBytes),
      objectId: job.uploadObjectId
    };
  }
  const artifact = await buildStoredPackage({
    repository,
    store,
    owner: current,
    manifest: job.manifest,
    upload,
    sourceId: job.sourceId ?? undefined,
    baseUrl: services.baseUrl.replace(/\/$/, ""),
    images: services.images
  });
  return artifact.id;
}
