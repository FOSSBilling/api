import { DurableObject } from "cloudflare:workers";
import { logError } from "@fossbilling/logging";
import { PackagingJobsDatabase } from "../../../services/extensions/v2/db/packaging-jobs";
import { processPackagingJob } from "../../../services/extensions/v2/packages/jobs";
import { prepareQueuedPackage } from "../../../services/extensions/v2/packages/prepare";
import { packagePreparation } from "./packaging-jobs";
import { createCloudflareBindings } from "./index";

const retryDelay = 60_000;
const idleDelay = 60 * retryDelay;

export function packageDispatcher(
  env: CloudflareBindings
): Pick<PreviewPackageDispatcher, "scope" | "wake"> {
  return env.PACKAGE_DISPATCHER.getByName("packaging");
}

// Keep the exported class name stable so existing Preview namespaces and
// their alarms survive deployment. Environments with dedicated D1 keep the
// original job scope. Previews partition their jobs in the shared D1.
export class PreviewPackageDispatcher extends DurableObject<CloudflareBindings> {
  async scope(): Promise<string> {
    if (
      createCloudflareBindings(this.env).environment.get("ENVIRONMENT") !==
      "preview"
    )
      return "";
    return this.ctx.storage.transaction(async (storage) => {
      const existing = await storage.get<string>("scope");
      if (existing) return existing;
      const scope = crypto.randomUUID();
      await storage.put("scope", scope);
      return scope;
    });
  }

  async wake(immediate = false): Promise<void> {
    await this.schedule(Date.now() + (immediate ? 0 : retryDelay));
  }

  async alarm(): Promise<void> {
    let nextWake: number;
    try {
      const jobs = new PackagingJobsDatabase(
        this.env.DB_EXTENSIONS,
        await this.scope()
      );
      await jobs.expire();
      let next = await jobs.nextForAlarm();
      if (next && next.due * 1000 <= Date.now()) {
        const result = await processPackagingJob(jobs, next.id, (job) =>
          prepareQueuedPackage(packagePreparation(this.env), job)
        );
        if (result === "busy") {
          await this.wake();
          return;
        }
        next = await jobs.nextForAlarm();
      }
      nextWake = Math.min(
        next ? next.due * 1000 : Infinity,
        Date.now() + idleDelay
      );
    } catch (error) {
      logError("extensions/packages", "Packaging alarm failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      nextWake = Date.now() + retryDelay;
    }
    await this.schedule(nextWake);
  }

  private async schedule(at: number): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.getAlarm();
      if (current === null || current > at) await storage.setAlarm(at);
    });
  }
}
