import { describe, expect, it, vi } from "vitest";
import {
  dispatchPackageJob,
  processPackageJob,
  type PackageJob,
  type PackageJobRepository
} from "../../../../src/services/extensions/v2/packages/jobs";
import { PackageError } from "../../../../src/services/extensions/v2/packages/errors";

function repository() {
  const job: PackageJob = {
    id: crypto.randomUUID(),
    fingerprint: "test",
    owner: {
      id: "developer",
      profile_generation: "generation",
      ownership_epoch: 1,
      owner_user_id: "owner"
    },
    manifest: {
      manifest_version: 1,
      type: "module",
      id: "example",
      name: "Example",
      version: "1.0.0",
      description: "Example",
      author: { name: "Developer" },
      license: "MIT",
      requires: { fossbilling: "*" }
    },
    sourceId: null,
    uploadObjectId: "upload",
    uploadSha256: "checksum",
    status: "queued",
    attempts: 0,
    artifactId: null,
    error: null,
    createdAt: "now",
    updatedAt: "now"
  };
  let activeLease: string | null = null;
  const jobs: PackageJobRepository = {
    get: async () => ({ ...job }),
    claim: async (_id, lease) => {
      if (job.status !== "queued") return null;
      activeLease = lease;
      job.status = "processing";
      job.attempts++;
      return { ...job };
    },
    complete: async (_id, lease, artifactId) => {
      if (lease === activeLease) {
        job.status = "ready";
        job.artifactId = artifactId;
        activeLease = null;
      }
    },
    fail: async (_id, lease, error, retry) => {
      if (lease === activeLease) {
        job.status = retry ? "queued" : "failed";
        job.error = error;
        activeLease = null;
      }
    },
    pending: async () => [job.id],
    markEnqueued: vi.fn().mockResolvedValue(undefined)
  };
  return { job, jobs };
}

describe("provider-independent package job processing", () => {
  it("publishes only an identifier through the queue interface", async () => {
    const { jobs, job } = repository();
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchPackageJob(jobs, { send }, job.id);
    expect(send).toHaveBeenCalledWith({ jobId: job.id });
    expect(jobs.markEnqueued).toHaveBeenCalledWith(job.id);
  });
  it("does not run completed jobs twice", async () => {
    const { jobs, job } = repository();
    const prepare = vi.fn().mockResolvedValue("artifact");
    expect(await processPackageJob(jobs, job.id, prepare)).toBe("ack");
    expect(await processPackageJob(jobs, job.id, prepare)).toBe("ack");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(job.artifactId).toBe("artifact");
  });
  it("retries transient failures with a bounded attempt count", async () => {
    const { jobs, job } = repository();
    const prepare = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    expect(await processPackageJob(jobs, job.id, prepare)).toBe("retry");
    expect(await processPackageJob(jobs, job.id, prepare)).toBe("retry");
    expect(await processPackageJob(jobs, job.id, prepare)).toBe("ack");
    expect(job.status).toBe("failed");
    expect(job.error?.message).not.toContain("storage unavailable");
  });
  it("does not retry invalid packages or revoked ownership", async () => {
    for (const status of [422, 403] as const) {
      const { jobs, job } = repository();
      expect(
        await processPackageJob(jobs, job.id, async () => {
          throw new PackageError("REJECTED", "Rejected", status);
        })
      ).toBe("ack");
      expect(job.status).toBe("failed");
      expect(job.attempts).toBe(1);
    }
  });
});
