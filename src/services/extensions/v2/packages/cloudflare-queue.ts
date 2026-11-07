import { createCloudflareBindings } from "../../../../lib/adapters/cloudflare";
import { CloudflareQueueAdapter } from "../../../../lib/adapters/cloudflare/queue";
import { PackageJobsDatabase } from "../db/package-jobs";
import { buildStoredPackage, packageOwner } from "./build";
import { PackageError } from "./errors";
import { boundedBytes, configuredPackageStore } from "./store";
import { processPackageJob, dispatchPackageJob, type PackageJob } from "./jobs";
import { PACKAGE_LIMITS } from "../package-builder";

export async function prepareQueuedPackage(
  env: CloudflareBindings,
  job: PackageJob
): Promise<string> {
  const getEnv = (name: string) =>
    createCloudflareBindings(env).environment.get(name);
  const store = configuredPackageStore(env, getEnv);
  if (!store)
    throw new PackageError(
      "PACKAGES_DISABLED",
      "Package storage is not configured",
      503
    );
  const previous = job.owner;
  const current = await packageOwner(
    env.DB_EXTENSIONS,
    previous.owner_user_id,
    job.manifest.id,
    previous.publisher_client_id
      ? {
          clientId: previous.publisher_client_id,
          developerId: previous.id,
          ownershipEpoch: previous.ownership_epoch,
          canPublish: false
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
  const source = job.uploadObjectId
    ? await boundedBytes(
        await store.get(job.uploadObjectId, job.uploadSha256 ?? undefined),
        PACKAGE_LIMITS.sourceBytes
      )
    : undefined;
  const artifact = await buildStoredPackage({
    db: env.DB_EXTENSIONS,
    store,
    owner: current,
    manifest: job.manifest,
    source,
    sourceObjectId: job.uploadObjectId ?? undefined,
    sourceId: job.sourceId ?? undefined,
    baseUrl: getEnv("EXTENSION_PACKAGES_BASE_URL")!.replace(/\/$/, ""),
    images: env.PACKAGE_IMAGES
  });
  return artifact.id;
}

export async function consumePackageJobs(
  batch: MessageBatch<{ jobId: string }>,
  env: CloudflareBindings
) {
  const jobs = new PackageJobsDatabase(env.DB_EXTENSIONS);
  for (const message of batch.messages) {
    if (
      !message.body ||
      typeof message.body.jobId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(message.body.jobId)
    ) {
      message.ack();
      continue;
    }
    try {
      const result = await processPackageJob(jobs, message.body.jobId, (job) =>
        prepareQueuedPackage(env, job)
      );
      if (result === "busy") message.retry({ delaySeconds: 1200 });
      else if (result === "retry") message.retry({ delaySeconds: 60 });
      else message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}

export async function recoverPackageJobs(env: CloudflareBindings) {
  const mode = createCloudflareBindings(env).environment.get(
    "EXTENSION_PACKAGES_MODE"
  );
  if (
    !env.EXTENSION_PACKAGE_QUEUE ||
    !["local", "enabled"].includes(mode ?? "")
  )
    return;
  const jobs = new PackageJobsDatabase(env.DB_EXTENSIONS);
  await jobs.expire();
  const queue = new CloudflareQueueAdapter(env.EXTENSION_PACKAGE_QUEUE);
  for (const id of await jobs.pending())
    await dispatchPackageJob(jobs, queue, id);
}
