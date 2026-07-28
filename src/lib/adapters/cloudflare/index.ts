import { IPlatformBindings } from "../../interfaces";
import { CloudflareKVAdapter } from "./cache";
import { CloudflareEnvironmentAdapter } from "./environment";

// Database access no longer goes through this platform-bindings
// abstraction - Drizzle wraps env.DB_EXTENSIONS/env.DB_CENTRAL_ALERTS
// directly (see src/lib/db.ts), since Hono's context already gives route
// handlers a typed `c.env` and Drizzle itself is the cross-driver
// abstraction now, making a hand-rolled IDatabase wrapper redundant.
export function createCloudflareBindings(
  env: CloudflareBindings
): IPlatformBindings {
  return {
    caches: {
      CACHE_KV: new CloudflareKVAdapter(env.CACHE_KV),
      AUTH_KV: new CloudflareKVAdapter(env.AUTH_KV)
    },
    environment: new CloudflareEnvironmentAdapter(
      env as unknown as Record<string, unknown>
    )
  };
}

export { CloudflareKVAdapter } from "./cache";
export { CloudflareEnvironmentAdapter } from "./environment";
