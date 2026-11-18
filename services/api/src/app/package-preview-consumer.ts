import { logError } from "@fossbilling/logging";
import {
  consumePackagingJobs,
  recoverPackagingJobs
} from "../lib/adapters/cloudflare/packaging-jobs";

// Named Previews cannot receive Queue or scheduled events.
export default {
  queue: consumePackagingJobs,
  scheduled: async (_event: ScheduledController, env: CloudflareBindings) => {
    try {
      await recoverPackagingJobs(env);
    } catch (error) {
      logError("extensions/packages", "Packaging job recovery failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
};
