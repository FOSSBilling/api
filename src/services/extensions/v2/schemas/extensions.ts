import { z } from "@hono/zod-openapi";
import { httpUrl, lowercaseId, PaginationSchema } from "./common";
import { PublicDeveloperSchema } from "./developers";

export const EXTENSION_TYPES = [
  "mod",
  "theme",
  "payment-gateway",
  "server-manager",
  "domain-registrar",
  "hook",
  "translation"
] as const;

// GET /extensions/mine is a static owner-only route registered before
// GET /extensions/{id}. Reserve its segment for new submissions so a newly
// published extension cannot become unreachable. Existing databases must be
// checked for this id before enabling the route; this schema cannot safely
// rename production catalogue rows.
// Private: isReservedExtensionId() lowercases before the lookup, and these
// literals are lowercase — reading the Set directly would miss "Mine".
const RESERVED_EXTENSION_IDS = new Set(["mine"]);

export function isReservedExtensionId(id: string): boolean {
  return RESERVED_EXTENSION_IDS.has(id.toLowerCase());
}

export const ReleaseSchema = z
  .object({
    tag: z.string().min(1).max(100),
    date: z.string().min(1).max(64),
    download_url: httpUrl(),
    changelog_url: httpUrl().optional(),
    min_fossbilling_version: z.string().min(1).max(100)
  })
  .strict()
  .openapi("Release");

export type Release = z.infer<typeof ReleaseSchema>;

export const RepositorySchema = z
  .object({
    type: z.enum(["github", "gitlab", "custom"]),
    repo: z.string().min(1).max(500)
  })
  .strict()
  .openapi("Repository");

export type Repository = z.infer<typeof RepositorySchema>;

export const LicenseSchema = z
  .object({
    name: z.string().min(1).max(100),
    URL: httpUrl().optional()
  })
  .strict()
  .openapi("License");

export type License = z.infer<typeof LicenseSchema>;

export const ExtensionPayloadSchema = z
  .object({
    id: lowercaseId("extension"),
    type: z.enum(EXTENSION_TYPES),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(4000),
    releases: z.array(ReleaseSchema).min(1).max(100),
    website: httpUrl(),
    license: LicenseSchema,
    icon_url: httpUrl().optional(),
    readme: z.string().min(1).max(100_000),
    source: RepositorySchema,
    version: z.string().min(1).max(100),
    download_url: httpUrl()
  })
  .strict()
  .openapi("ExtensionPayload");

export const ExtensionSchema = ExtensionPayloadSchema.extend({
  developer: PublicDeveloperSchema
}).openapi("Extension");

export type Extension = z.infer<typeof ExtensionSchema>;

// Catalogue cards do not need the potentially large README or every historic
// release. Consumers can fetch those fields from GET /extensions/{id} when a
// visitor opens an extension's detail page.
export const ExtensionListItemSchema = ExtensionSchema.omit({
  readme: true,
  releases: true
}).openapi("ExtensionListItem");

export type ExtensionListItem = z.infer<typeof ExtensionListItemSchema>;

export const ExtensionListQuerySchema = z.object({
  type: z
    .enum(EXTENSION_TYPES)
    .optional()
    .openapi({
      param: { name: "type", in: "query" }
    }),
  developer_id: z
    .string()
    .optional()
    .openapi({
      param: { name: "developer_id", in: "query" }
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .openapi({ param: { name: "limit", in: "query" } }),
  cursor: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .openapi({
      param: { name: "cursor", in: "query" },
      description: "Opaque cursor returned by the previous page"
    })
});

// The owner-scoped list has the same pagination and type filters as the
// public catalogue, but its developer is always taken from the authenticated
// user. Keeping a separate schema prevents OpenAPI from advertising a
// developer_id filter that this endpoint deliberately ignores.
export const ExtensionMineListQuerySchema = ExtensionListQuerySchema.omit({
  developer_id: true
});

export const ExtensionListResponseSchema = z
  .object({
    result: z.array(ExtensionListItemSchema),
    pagination: PaginationSchema
  })
  .openapi("ExtensionListResponse");
