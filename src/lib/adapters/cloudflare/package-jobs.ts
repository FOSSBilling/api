import { logError } from "../../logger";
import { createCloudflareBindings } from "./index";
import { PackageJobsDatabase } from "../../../services/extensions/v2/db/package-jobs";
import { PackageBuildDatabase } from "../../../services/extensions/v2/db/package-builds";
import {
  prepareQueuedPackage,
  type PackagePreparation
} from "../../../services/extensions/v2/packages/prepare";
import {
  processPackageJob,
  dispatchPackageJob
} from "../../../services/extensions/v2/packages/jobs";
import { PackageError } from "../../../services/extensions/v2/packages/errors";
import { configuredPackageStore } from "./package-store";
import { CloudflarePackageImages } from "./package-images";

type PackageBindings = CloudflareBindings & {
  EXTENSION_PACKAGE_BUCKET?: R2Bucket;
};
export function packagePreparation(env: PackageBindings): PackagePreparation {
  const bindings = createCloudflareBindings(env);
  const getEnv = (name: string) => bindings.environment.get(name);
  const store = configuredPackageStore(env, getEnv);
  const baseUrl = getEnv("EXTENSION_PACKAGES_BASE_URL");
  if (!store || !baseUrl)
    throw new PackageError(
      "PACKAGES_DISABLED",
      "Package storage or download URL is not configured",
      503
    );
  return {
    repository: new PackageBuildDatabase(env.DB_EXTENSIONS),
    store,
    images: new CloudflarePackageImages(env.PACKAGE_IMAGES),
    baseUrl
  };
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
        prepareQueuedPackage(packagePreparation(env), job)
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
  const queue = createCloudflareBindings(env).queues!.EXTENSION_PACKAGE_QUEUE;
  for (const id of await jobs.pending()) {
    try {
      await dispatchPackageJob(jobs, queue, id);
    } catch (error) {
      logError("extensions/packages", "Package job dispatch failed", {
        jobId: id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
