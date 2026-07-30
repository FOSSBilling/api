import { Context } from "hono";
import { ICache, IPlatformBindings } from "./interfaces";

export interface PlatformContext {
  getCache(name: string): ICache;
  getEnv(key: string): string | undefined;
  readonly raw: Context;
}

export function createPlatformContext(
  c: Context,
  bindings: IPlatformBindings
): PlatformContext {
  return {
    getCache(name: string): ICache {
      const cache = bindings.caches[name];
      if (!cache) {
        throw new Error(`Cache binding '${name}' not found`);
      }
      return cache;
    },

    getEnv(key: string): string | undefined {
      return bindings.environment.get(key);
    },

    get raw(): Context {
      return c;
    }
  };
}
