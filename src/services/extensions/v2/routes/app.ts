import { OpenAPIHono } from "@hono/zod-openapi";

export type ExtensionsV2App = OpenAPIHono<{
  Bindings: CloudflareBindings;
}>;
