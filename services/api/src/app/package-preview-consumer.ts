import {
  consumePackagingJobs,
  recoverPackagingJobs
} from "../lib/adapters/cloudflare/packaging-jobs";

// Named Previews cannot receive Queue or scheduled events.
export default {
  queue: consumePackagingJobs,
  scheduled: (_event: ScheduledController, env: CloudflareBindings) =>
    recoverPackagingJobs(env)
};
