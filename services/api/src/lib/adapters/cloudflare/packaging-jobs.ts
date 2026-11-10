import { logError } from "@fossbilling/logging";
import { createCloudflareBindings } from "./index";
import { PackagingJobsDatabase } from "../../../services/extensions/v2/db/packaging-jobs";
import { PackageBuildDatabase } from "../../../services/extensions/v2/db/package-builds";
import {
  prepareQueuedPackage,
  type PackagePreparation
} from "../../../services/extensions/v2/packages/prepare";
import {
  processPackagingJob,
  dispatchPackagingJob
} from "../../../services/extensions/v2/packages/jobs";
import { PackageError } from "@fossbilling/extension-packaging/errors";
import { configuredPackageStore } from "../../../services/extensions/v2/packages/store";
import { HttpPackageProcessor } from "@fossbilling/extension-packaging/adapters/http";

export function packagePreparation(
  env: CloudflareBindings
): PackagePreparation {
  const bindings = createCloudflareBindings(env);
  const getEnv = (name: string) => bindings.environment.get(name);
  const store = configuredPackageStore(getEnv);
  const baseUrl = getEnv("EXTENSION_PACKAGES_BASE_URL");
  if (!store || !baseUrl)
    throw new PackageError(
      "PACKAGES_DISABLED",
      "Package storage or download URL is not configured",
      503
    );
  const processorUrl = getEnv("EXTENSION_PACKAGER_URL");
  const processorSecret = getEnv("EXTENSION_PACKAGER_SECRET");
  if (!processorUrl || !processorSecret)
    throw new PackageError(
      "PACKAGES_DISABLED",
      "Package processor is not configured",
      503
    );
  return {
    repository: new PackageBuildDatabase(env.DB_EXTENSIONS),
    store,
    processor: new HttpPackageProcessor(
      processorUrl,
      processorSecret,
      getEnv("ENVIRONMENT") !== "production"
    ),
    baseUrl
  };
}

export async function consumePackagingJobs(
  batch: MessageBatch<{ jobId: string }>,
  env: CloudflareBindings
) {
  const jobs = new PackagingJobsDatabase(env.DB_EXTENSIONS);
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
      const result = await processPackagingJob(
        jobs,
        message.body.jobId,
        (job) => prepareQueuedPackage(packagePreparation(env), job)
      );
      if (result === "busy") message.retry({ delaySeconds: 1200 });
      else if (result === "retry") message.retry({ delaySeconds: 60 });
      else message.ack();
    } catch (error) {
      logError("extensions/packages", "Package consumer failed", {
        jobId: message.body.jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      message.retry({ delaySeconds: 60 });
    }
  }
}

export async function recoverPackagingJobs(env: CloudflareBindings) {
  const mode = createCloudflareBindings(env).environment.get(
    "EXTENSION_PACKAGES_MODE"
  );
  if (
    !env.EXTENSION_PACKAGE_QUEUE ||
    !["local", "enabled"].includes(mode ?? "")
  )
    return;
  const jobs = new PackagingJobsDatabase(env.DB_EXTENSIONS);
  await jobs.expire();
  const queue = createCloudflareBindings(env).queues!.EXTENSION_PACKAGE_QUEUE;
  for (const id of await jobs.pending()) {
    try {
      await dispatchPackagingJob(jobs, queue, id);
    } catch (error) {
      logError("extensions/packages", "Packaging job dispatch failed", {
        jobId: id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
