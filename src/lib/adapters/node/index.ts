import { IPlatformBindings } from "../../interfaces";
import { createMemoryCache, createFileCache } from "./cache";
import { NodeEnvironmentAdapter } from "./environment";

// No database entry here - Drizzle only wraps the real D1 bindings (see
// src/lib/db.ts). The Node path is the standing proof that the
// IPlatformBindings seam (KV-shaped caches + string environment) is
// implementable off-Cloudflare; handlers still reach for platform services
// (D1, R2, Durable Objects, typed env) directly, so a full port needs
// service-level changes too. It has no production consumer today by design.
export function createNodeBindings(cacheDbPath?: string): IPlatformBindings {
  const cacheKv = cacheDbPath
    ? createFileCache(`${normalizePath(cacheDbPath)}.kv`)
    : createMemoryCache();
  const authKv = cacheDbPath
    ? createFileCache(`${normalizePath(cacheDbPath)}.auth`)
    : createMemoryCache();

  return {
    caches: {
      CACHE_KV: cacheKv,
      AUTH_KV: authKv
    },
    environment: new NodeEnvironmentAdapter()
  };
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\/+$/, "");
  normalized = normalized.replace(/\.+$/, "");
  normalized = normalized.replace(/\.(?:sqlite|db|sqlite3)$/i, "");

  return normalized;
}

export {
  SQLiteCacheAdapter,
  createMemoryCache,
  createFileCache
} from "./cache";
export { NodeEnvironmentAdapter } from "./environment";
