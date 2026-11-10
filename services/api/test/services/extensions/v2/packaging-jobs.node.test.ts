import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchPackagingJob,
  processPackagingJob,
  type PackagingJob,
  type PackagingJobRepository
} from "../../../../src/services/extensions/v2/packages/jobs";
import { PackageError } from "@fossbilling/extension-packaging/errors";

function repository() {
  const job: PackagingJob = {
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
  const jobs: PackagingJobRepository = {
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

afterEach(() => vi.restoreAllMocks());

describe("provider-independent packaging job processing", () => {
  it("publishes only an identifier through the queue interface", async () => {
    const { jobs, job } = repository();
    const send = vi.fn().mockResolvedValue(undefined);
    await dispatchPackagingJob(jobs, { send }, job.id);
    expect(send).toHaveBeenCalledWith({ jobId: job.id });
    expect(jobs.markEnqueued).toHaveBeenCalledWith(job.id);
  });
  it("leaves an actively leased job unchanged when another delivery arrives", async () => {
    const { jobs, job } = repository();
    job.status = "processing";
    const prepare = vi.fn();
    expect(await processPackagingJob(jobs, job.id, prepare)).toBe("busy");
    expect(job.status).toBe("processing");
    expect(job.attempts).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("terminates jobs interrupted beyond the processing attempt limit", async () => {
    const { jobs, job } = repository();
    job.attempts = 3;
    const prepare = vi.fn();
    expect(await processPackagingJob(jobs, job.id, prepare)).toBe("ack");
    expect(job.attempts).toBe(4);
    expect(job.status).toBe("failed");
    expect(job.error).toMatchObject({
      code: "PACKAGE_UNAVAILABLE",
      status: 503
    });
    expect(prepare).not.toHaveBeenCalled();
  });
  it("does not run completed jobs twice", async () => {
    const { jobs, job } = repository();
    const prepare = vi.fn().mockResolvedValue("artifact");
    expect(await processPackagingJob(jobs, job.id, prepare)).toBe("ack");
    expect(await processPackagingJob(jobs, job.id, prepare)).toBe("ack");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(job.artifactId).toBe("artifact");
  });
  it("retries transient failures with a bounded attempt count", async () => {
    const { jobs, job } = repository();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    expect(await processPackagingJob(jobs, job.id, prepare)).toBe("retry");
    expect(await processPackagingJob(jobs, job.id, prepare)).toBe("retry");
    expect(await processPackagingJob(jobs, job.id, prepare)).toBe("ack");
    expect(job.status).toBe("failed");
    expect(job.error?.message).not.toContain("storage unavailable");
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          jobId: job.id,
          error: "storage unavailable"
        })
      })
    );
  });
  it("does not retry invalid packages or revoked ownership", async () => {
    for (const status of [422, 403] as const) {
      const { jobs, job } = repository();
      expect(
        await processPackagingJob(jobs, job.id, async () => {
          throw new PackageError("REJECTED", "Rejected", status);
        })
      ).toBe("ack");
      expect(job.status).toBe("failed");
      expect(job.attempts).toBe(1);
    }
  });
});
