import { IPlatformBindings } from "../../interfaces";
import { createMemoryCache, createFileCache } from "./cache";
import { NodeEnvironmentAdapter } from "./environment";
import { createDefaultAdapter } from "./database";

export function createNodeBindings(cacheDbPath?: string): IPlatformBindings {
  const cacheKv = cacheDbPath
    ? createFileCache(`${normalizePath(cacheDbPath)}.kv`)
    : createMemoryCache();
  const authKv = cacheDbPath
    ? createFileCache(`${normalizePath(cacheDbPath)}.auth`)
    : createMemoryCache();

  return {
    databases: {
      DB_EXTENSIONS: createDefaultAdapter()
    },
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
export {
  SQLiteAdapter,
  createInMemoryDatabase,
  createFileDatabase,
  createDefaultAdapter
} from "./database";
