import { IPlatformBindings } from "../../interfaces";
import { CloudflareD1Adapter } from "./database";
import { CloudflareKVAdapter } from "./cache";
import { CloudflareEnvironmentAdapter } from "./environment";

export function createCloudflareBindings(
  env: CloudflareBindings
): IPlatformBindings {
  return {
    databases: {
      DB_CENTRAL_ALERTS: new CloudflareD1Adapter(env.DB_CENTRAL_ALERTS),
      DB_EXTENSIONS: new CloudflareD1Adapter(env.DB_EXTENSIONS)
    },
    caches: {
      CACHE_KV: new CloudflareKVAdapter(env.CACHE_KV),
      AUTH_KV: new CloudflareKVAdapter(env.AUTH_KV)
    },
    environment: new CloudflareEnvironmentAdapter(
      env as unknown as Record<string, unknown>
    )
  };
}

export { CloudflareD1Adapter } from "./database";
export { CloudflareKVAdapter } from "./cache";
export { CloudflareEnvironmentAdapter } from "./environment";
