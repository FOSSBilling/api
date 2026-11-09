import { logError } from "../../../../lib/logger";
import type { IMessageQueue } from "../../../../lib/interfaces";
import type { Manifest } from "../schemas/manifest";
import type { PackageOwner } from "./repository";
import { PackageError } from "./errors";

export interface PackageJob {
  id: string;
  fingerprint: string;
  owner: PackageOwner;
  manifest: Manifest;
  sourceId: string | null;
  uploadObjectId: string | null;
  uploadSha256: string | null;
  status: "queued" | "processing" | "ready" | "failed";
  attempts: number;
  artifactId: string | null;
  error: { code: string; message: string; status: number } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PackageJobRepository {
  get(id: string): Promise<PackageJob | null>;
  claim(id: string, lease: string): Promise<PackageJob | null>;
  complete(id: string, lease: string, artifactId: string): Promise<void>;
  fail(
    id: string,
    lease: string,
    error: NonNullable<PackageJob["error"]>,
    retry: boolean
  ): Promise<void>;
  pending(): Promise<string[]>;
  markEnqueued(id: string): Promise<void>;
}

export async function dispatchPackageJob(
  jobs: PackageJobRepository,
  queue: IMessageQueue,
  id: string
) {
  await queue.send({ jobId: id });
  await jobs.markEnqueued(id);
}

// Delivery-specific acknowledgement/retry APIs stay in the platform adapter.
export async function processPackageJob(
  jobs: PackageJobRepository,
  id: string,
  prepare: (job: PackageJob) => Promise<string>,
  lease = crypto.randomUUID()
): Promise<"ack" | "retry" | "busy"> {
  const existing = await jobs.get(id);
  if (!existing || existing.status === "ready" || existing.status === "failed")
    return "ack";
  const job = await jobs.claim(id, lease);
  if (!job) return "busy";
  try {
    if (job.attempts > 3)
      throw new PackageError(
        "PACKAGE_UNAVAILABLE",
        "Package processing was interrupted repeatedly. Please try again.",
        503
      );
    const artifactId = await prepare(job);
    await jobs.complete(id, lease, artifactId);
    return "ack";
  } catch (cause) {
    if (!(cause instanceof PackageError))
      logError("extensions/packages", "Package preparation failed", {
        jobId: id,
        error: cause instanceof Error ? cause.message : String(cause)
      });
    const error =
      cause instanceof PackageError
        ? { code: cause.code, message: cause.message, status: cause.status }
        : {
            code: "PACKAGE_UNAVAILABLE",
            message:
              "Package processing is temporarily unavailable. Please try again.",
            status: 503
          };
    const retry = error.status === 503 && job.attempts < 3;
    await jobs.fail(id, lease, error, retry);
    return retry ? "retry" : "ack";
  }
}
