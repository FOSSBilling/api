import { OpenAPIHono } from "@hono/zod-openapi";
import { getAuth, requireAuth } from "../../../lib/auth";
import { getExtensionsDb } from "../../../lib/db";
import { getPlatform } from "../../../lib/middleware";
import { MiddlewareHandler } from "hono";

export type ExtensionsV2App = OpenAPIHono<{
  Bindings: CloudflareBindings;
}>;

export interface RouteDependencies {
  database: typeof getExtensionsDb;
  auth: typeof getAuth;
  platform: typeof getPlatform;
  requireAuth: typeof requireAuth;
  requireModerator: () => MiddlewareHandler;
}
