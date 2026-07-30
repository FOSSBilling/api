import { IPlatformBindings } from "../../interfaces";
import { createMemoryCache, createFileCache } from "./cache";
import { NodeEnvironmentAdapter } from "./environment";

// No database entry here - Drizzle only wraps the real D1 bindings (see
// src/lib/db.ts); the Node path exists solely to test the cache/environment
// adapters outside Workers, so it never had a real production consumer for
// a database binding (only src/app/index.ts's createCloudflareBindings does).
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
