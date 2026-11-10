import { Context } from "hono";
import { ICache, IMessageQueue, IPlatformBindings } from "./interfaces";

export interface PlatformContext {
  getQueue(name: string): IMessageQueue;
  getCache(name: string): ICache;
  getEnv(key: string): string | undefined;
  readonly raw: Context;
}

export function createPlatformContext(
  c: Context,
  bindings: IPlatformBindings
): PlatformContext {
  return {
    getQueue(name: string): IMessageQueue {
      const queue = bindings.queues?.[name];
      if (!queue) throw new Error(`Queue binding '${name}' not found`);
      return queue;
    },
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
