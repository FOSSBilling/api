import { z } from "@hono/zod-openapi";
import SPDX_LICENSE_IDS from "spdx-license-ids/index.json";
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
// GET /extensions/{id}. Reserve its segment so a newly created extension
// cannot become unreachable. This schema cannot rename an already-adopted
// row, so migration 0020 fails the deploy if one exists.
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

// Re-exported so callers (and tests) validate against the exact same set
// this schema uses, rather than a hand-copied list that can drift.
// `spdx-license-ids` ships only the current (non-deprecated) identifiers —
// https://github.com/jslicense/spdx-license-ids — so submitters are steered
// toward the license SPDX currently recommends, not a retired alias.
export { SPDX_LICENSE_IDS };

const spdxLicenseId = () =>
  z
    .string()
    .refine((value) => SPDX_LICENSE_IDS.includes(value), {
      message: "must be a current (non-deprecated) SPDX license identifier"
    })
    .openapi({
      description:
        "A current SPDX license identifier (https://spdx.org/licenses/). " +
        "Omitted for custom or proprietary licenses.",
      example: "MIT"
    });

export const LicenseSchema = z
  .object({
    name: z.string().min(1).max(100),
    spdx_id: spdxLicenseId().optional(),
    URL: httpUrl().optional()
  })
  .strict()
  .openapi("License");

export type License = z.infer<typeof LicenseSchema>;

// Everything about an extension that a developer can edit. Excludes `id`,
// which is the resource's identity and is carried by the URL. This is what a
// revision stores and what moderators approve.
export const ExtensionContentSchema = z
  .object({
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
  .openapi("ExtensionContent");

export type ExtensionContent = z.infer<typeof ExtensionContentSchema>;

// What a *stored* revision may hold, as opposed to what may be submitted now.
// Revision history is an audit log that outlives the rules content was written
// under, so promising that every historical record satisfies today's input
// validation is a promise this service cannot keep - migration 0021 carries
// submissions through verbatim, and any future tightening would break older
// rows the same way.
//
// Every field is therefore optional, and releases loses its minimum: this
// describes what is *there*, and a consumer reading history has to cope with
// a record written under rules that no longer exist. Field types and upper
// bounds are kept, since those still say something true about the shape.
// Nothing is weakened for publication - approve() revalidates against the
// strict schema before anything reaches the catalogue.
export const StoredExtensionContentSchema = ExtensionContentSchema.extend({
  releases: z.array(ReleaseSchema).max(100)
})
  .partial()
  .openapi("StoredExtensionContent");

export type StoredExtensionContent = z.infer<
  typeof StoredExtensionContentSchema
>;

const MAX_CONTENT_BYTES = 256 * 1024;

// Applied to both the create and the edit body. The stored revision is this
// object verbatim, so bounding it here bounds the row.
function refineContentSize(content: unknown, ctx: z.RefinementCtx): void {
  const size = new TextEncoder().encode(JSON.stringify(content)).byteLength;
  if (size > MAX_CONTENT_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Extension content must not exceed 256 KiB"
    });
  }
}

// POST /extensions. The id is chosen once here and is immutable afterwards.
// No developer field: a user owns at most one profile, so the server knows it.
export const ExtensionCreateSchema = ExtensionContentSchema.extend({
  id: lowercaseId("extension").refine((id) => !isReservedExtensionId(id), {
    message: "This extension id is reserved"
  })
})
  .strict()
  .superRefine(refineContentSize)
  .openapi("ExtensionCreate");

// PUT /extensions/{id}. Same content, no id — that comes from the path.
// .strict() belongs here and not on ExtensionContentSchema, which is also a
// branch of the responses below; see DeveloperInputSchema for why.
export const ExtensionUpdateSchema = ExtensionContentSchema.strict()
  .superRefine(refineContentSize)
  .openapi("ExtensionUpdate");

// The public projection: published content plus the developer that owns it.
export const ExtensionSchema = ExtensionContentSchema.extend({
  id: z.string(),
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

const ExtensionCardContentSchema = ExtensionContentSchema.omit({
  readme: true,
  releases: true
});

// The published projection as its *owner* sees it. Identical to the
// catalogue's, except releases may be empty: v1 constrained
// extensions.releases to NOT NULL and nothing more, so a row adopted by
// migration 0021 can legitimately have none, and the owner view is where
// someone looks at what is actually there rather than at an idealised copy.
// This can only ever describe a pre-v2 row - approve() requires a release
// before anything reaches the catalogue through v2.
const PublishedExtensionContentSchema = ExtensionContentSchema.extend({
  releases: z.array(ReleaseSchema).max(100)
});

// The most recent decision, kept alongside a later pending revision so the
// site can still show why the previous attempt was rejected.
export const RevisionReviewSchema = z
  .object({
    revision_id: z.string(),
    status: z.enum(["approved", "rejected"]),
    review_note: z.string().nullable(),
    reviewed_at: z.string().nullable()
  })
  .openapi("RevisionReview");

const PendingRevisionRefSchema = z
  .object({
    id: z.string(),
    created_at: z.string()
  })
  .openapi("PendingRevisionRef");

// Set once a moderator pulls an already-published extension from the
// catalogue for cause (its upstream source disappearing, for example).
// Content and history are kept, so the owner can still see and edit the
// extension - they just cannot get it back into the catalogue without a
// moderator re-listing it.
export const DelistedInfoSchema = z
  .object({
    reason: z.string(),
    at: z.string()
  })
  .openapi("DelistedInfo");

// published, pending_revision, last_review and delisted are independent — a
// live extension with an unreviewed edit has all three of the first, and a
// delisted one keeps whichever of them it already had. There is deliberately
// no derived `status` field on top; see the README for how they map to a UI.
export const OwnedExtensionListItemSchema = z
  .object({
    id: z.string(),
    developer: PublicDeveloperSchema,
    published: ExtensionCardContentSchema.nullable(),
    pending_revision: PendingRevisionRefSchema.nullable(),
    last_review: RevisionReviewSchema.nullable(),
    delisted: DelistedInfoSchema.nullable(),
    created_at: z.string(),
    updated_at: z.string()
  })
  .openapi("OwnedExtensionListItem");

export type OwnedExtensionListItem = z.infer<
  typeof OwnedExtensionListItemSchema
>;

// The detail view carries the full content on both sides, so an owner can
// render a published-vs-pending diff from one request.
export const OwnedExtensionSchema = OwnedExtensionListItemSchema.extend({
  published: PublishedExtensionContentSchema.nullable(),
  pending_revision: PendingRevisionRefSchema.extend({
    content: StoredExtensionContentSchema
  }).nullable()
}).openapi("OwnedExtension");

export type OwnedExtension = z.infer<typeof OwnedExtensionSchema>;

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

// A moderator's view of the whole catalogue, not just the public one: every
// status a developer can be in, filterable by the same states OwnedExtension
// itself distinguishes (see its comment) rather than a derived label.
export const ModerationExtensionListQuerySchema = ExtensionListQuerySchema.omit(
  { developer_id: true }
).extend({
  status: z
    .enum(["published", "delisted", "unpublished"])
    .optional()
    .openapi({ param: { name: "status", in: "query" } }),
  q: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      param: { name: "q", in: "query" },
      description: "Case-insensitive substring match on the extension id"
    })
});

export const ExtensionListResponseSchema = z
  .object({
    result: z.array(ExtensionListItemSchema),
    pagination: PaginationSchema
  })
  .openapi("ExtensionListResponse");

export const OwnedExtensionListResponseSchema = z
  .object({
    result: z.array(OwnedExtensionListItemSchema),
    pagination: PaginationSchema
  })
  .openapi("OwnedExtensionListResponse");
