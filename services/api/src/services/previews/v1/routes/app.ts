import { OpenAPIHono } from "@hono/zod-openapi";

export type PreviewsV1App = OpenAPIHono<{
  Bindings: CloudflareBindings;
}>;
