import { ICache, IMessageQueue, IPlatformBindings } from "./interfaces";

export interface PlatformContext {
  getQueue(name: string): IMessageQueue;
  getCache(name: string): ICache;
  getEnv(key: string): string | undefined;
  fetchService(name: string, request: Request): Promise<Response>;
  checkRateLimit(name: string, key: string): Promise<boolean>;
  waitUntil(promise: Promise<unknown>): void;
}

export function createPlatformContext(
  bindings: IPlatformBindings,
  waitUntil: (promise: Promise<unknown>) => void
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

    async fetchService(name: string, request: Request): Promise<Response> {
      const service = bindings.services?.[name];
      if (!service) throw new Error(`Service binding '${name}' not found`);
      return service(request);
    },

    async checkRateLimit(name: string, key: string): Promise<boolean> {
      const limiter = bindings.rateLimiters?.[name];
      if (!limiter) throw new Error(`Rate limiter binding '${name}' not found`);
      return limiter(key);
    },

    waitUntil
  };
}
