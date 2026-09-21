import { IPlatformBindings } from "../../interfaces";
import { CloudflareKVAdapter } from "./cache";
import { CloudflareEnvironmentAdapter } from "./environment";

// Database access no longer goes through this platform-bindings
// abstraction - Drizzle wraps env.DB_EXTENSIONS/env.DB_CENTRAL_ALERTS
// directly (see src/lib/db.ts), since Hono's context already gives route
// handlers a typed `c.env` and Drizzle itself is the cross-driver
// abstraction now, making a hand-rolled IDatabase wrapper redundant.
//
// Memoized per env object: the adapter graph is deterministic given the
// bindings, and env identity is stable for the isolate's lifetime.
const bindingsCache = new WeakMap<CloudflareBindings, IPlatformBindings>();

export function createCloudflareBindings(
  env: CloudflareBindings
): IPlatformBindings {
  let bindings = bindingsCache.get(env);
  if (!bindings) {
    bindings = {
      caches: {
        CACHE_KV: new CloudflareKVAdapter(env.CACHE_KV),
        AUTH_KV: new CloudflareKVAdapter(env.AUTH_KV)
      },
      environment: new CloudflareEnvironmentAdapter(
        env as unknown as Record<string, unknown>
      )
    };
    bindingsCache.set(env, bindings);
  }
  return bindings;
}

export { CloudflareKVAdapter } from "./cache";
export { CloudflareEnvironmentAdapter } from "./environment";
