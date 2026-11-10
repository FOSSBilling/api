import { Context, MiddlewareHandler } from "hono";
import { IPlatformBindings } from "./interfaces";
import { createPlatformContext, PlatformContext } from "./context";

declare module "hono" {
  interface ContextVariableMap {
    platform: PlatformContext;
  }
}

export function platformMiddleware(
  bindings: IPlatformBindings,
  waitUntil: (promise: Promise<unknown>) => void
): MiddlewareHandler {
  return async (c, next) => {
    c.set("platform", createPlatformContext(bindings, waitUntil));
    await next();
  };
}

export function getPlatform(c: Context): PlatformContext {
  const platform = c.get("platform");
  if (!platform) {
    throw new Error("Platform context not found");
  }
  return platform;
}
