import { MAX_CONTENT_BYTES } from "../resource-limits";
import { z } from "@hono/zod-openapi";
import {
  ManifestSchema,
  MANIFEST_EXTENSION_TYPES,
  ManifestRequirementsSchema
} from "./manifest";
import { cursorPaginationFields, httpUrl, PaginationSchema } from "./common";
import { PublicDeveloperSchema } from "./developers";

export const EXTENSION_TYPES = MANIFEST_EXTENSION_TYPES;

export const ReleaseSchema = z
  .object({
    tag: z.string().min(1).max(100),
    date: z.string().min(1).max(64),
    download_url: httpUrl(),
    changelog_url: httpUrl().optional(),
    requires: ManifestRequirementsSchema
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

export const LicenseSchema = ManifestSchema.shape.license;
export type License = z.infer<typeof LicenseSchema>;

// Everything about an extension that a developer can edit. Excludes `id`,
// which is the resource's identity and is carried by the URL. This is what a
// revision stores and what moderators approve.
export const ExtensionContentSchema = z
  .object({
    manifest_version: ManifestSchema.shape.manifest_version,
    type: ManifestSchema.shape.type,
    name: ManifestSchema.shape.name,
    description: ManifestSchema.shape.description,
    author: ManifestSchema.shape.author,
    requires: ManifestSchema.shape.requires,
    releases: z.array(ReleaseSchema).min(1).max(100),
    homepage_url: ManifestSchema.shape.homepage_url,
    license: LicenseSchema,
    icon_url: ManifestSchema.shape.icon_url,
    readme: z.string().min(1).max(100_000),
    source: RepositorySchema,
    version: ManifestSchema.shape.version,
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
// strict schema before anything reaches the extension directory.
// SQLite length() counts Unicode code points. Use the same bound for legacy
// reads, with a 200-code-unit ceiling so supplementary characters still fit.
const StoredReleaseSchema = ReleaseSchema.extend({
  requires: ManifestRequirementsSchema.optional(),
  min_fossbilling_version: z.string().min(1).max(100).optional(),
  tag: z
    .string()
    .min(1)
    .max(200)
    .refine((tag) => Array.from(tag).length <= 100)
    .describe("At most 100 Unicode code points in historical content")
});

export const StoredExtensionContentSchema = ExtensionContentSchema.extend({
  type: z.enum([...EXTENSION_TYPES, "mod", "hook"]),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  version: z.string().min(1).max(100),
  icon_url: z.union([ManifestSchema.shape.icon_url, httpUrl()]).optional(),
  website: httpUrl().optional(),
  license: z.union([
    LicenseSchema,
    z.object({
      name: z.string(),
      spdx_id: z.string().optional(),
      URL: httpUrl().optional()
    })
  ]),
  releases: z.array(StoredReleaseSchema).max(100)
})
  .partial()
  .openapi("StoredExtensionContent");

export type StoredExtensionContent = z.infer<
  typeof StoredExtensionContentSchema
>;

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

// POST /extensions. The public identifier is chosen once; the API generates its UUID.
// No developer field: a user owns at most one profile, so the server knows it.
export const ExtensionCreateSchema = ExtensionContentSchema.extend({
  identifier: ManifestSchema.shape.id
})
  .strict()
  .superRefine(refineContentSize)
  .openapi("ExtensionCreate");

// PUT /extensions/{id}. The public identifier comes from the path.
// .strict() belongs here and not on ExtensionContentSchema, which is also a
// branch of the responses below; see DeveloperInputSchema for why.
export const ExtensionUpdateSchema = ExtensionContentSchema.strict()
  .superRefine(refineContentSize)
  .openapi("ExtensionUpdate");

// Published reads also cover pre-manifest rows, whose display fields and
// icon URLs may predate the current input constraints.
const PublishedContentSchema = ExtensionContentSchema.extend({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  version: z.string().min(1).max(100),
  license: z.string().min(1),
  homepage_url: z.string().min(1).optional(),
  download_url: z.string().min(1),
  icon_url: z.string().optional()
});

// The public projection: published package attribution plus its current owner.
export const ExtensionSchema = PublishedContentSchema.extend({
  id: z.uuidv7(),
  identifier: z.string(),
  developer: PublicDeveloperSchema
}).openapi("Extension");

export type Extension = z.infer<typeof ExtensionSchema>;

// Extension cards omit the README, release history, and requirements map. Consumers can fetch those fields from GET /extensions/{id} when a
// visitor opens an extension's detail page.
const ExtensionCardContentSchema = ExtensionContentSchema.omit({
  readme: true,
  releases: true,
  requires: true
}).extend({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  version: z.string().min(1).max(100),
  license: z.string().min(1).max(1000),
  icon_url: z.string().max(2048).optional(),
  homepage_url: httpUrl()
    .nullable()
    .optional()
    .describe("Null when a legacy URL exceeds the card length bound"),
  download_url: httpUrl()
    .nullable()
    .describe("Null when a legacy URL exceeds the card length bound")
});

export const ExtensionListItemSchema = ExtensionCardContentSchema.extend({
  id: z.uuidv7(),
  identifier: z.string(),
  developer: PublicDeveloperSchema
}).openapi("ExtensionListItem");

export type ExtensionListItem = z.infer<typeof ExtensionListItemSchema>;

// The published projection as its *owner* sees it. Identical to the
// public listing's, except releases may be empty: v1 constrained
// extensions.releases to NOT NULL and nothing more, so a row adopted by
// migration 0021 can legitimately have none, and the owner view is where
// someone looks at what is actually there rather than at an idealised copy.
// This can only ever describe a pre-v2 row - approve() requires a release
// before anything reaches the extension directory through v2.
const PublishedExtensionContentSchema = PublishedContentSchema.extend({
  releases: z.array(StoredReleaseSchema).max(100)
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
// extension directory for cause (its upstream source disappearing, for example).
// Content and history are kept, so the owner can still see and edit the
// extension - they just cannot get it back into the extension directory without a
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
    id: z.uuidv7(),
    identifier: z.string(),
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
  developer_identifier: z
    .string()
    .optional()
    .openapi({
      param: { name: "developer_identifier", in: "query" }
    }),
  ...cursorPaginationFields
});

// Unified list query for the merged GET /extensions (optional auth,
// role-aware). scope selects the projection: public (published extension
// cards, anonymous allowed), mine (caller's own Owned rows), all (moderator's
// view of all Owned rows). developer_identifier is public-only, status/q are
// all-only; mismatched combinations are rejected with 422 so a caller cannot
// silently get a different projection than requested.
export const ExtensionListScopeSchema = z.enum(["public", "mine", "all"]);

export const ExtensionStatusSchema = z.enum([
  "published",
  "delisted",
  "unpublished"
]);

export const UnifiedExtensionListQuerySchema = ExtensionListQuerySchema.extend({
  scope: ExtensionListScopeSchema.default("public").openapi({
    param: { name: "scope", in: "query" },
    description:
      "public: published extension directory (anonymous allowed). mine: caller's own extensions. all: every extension (moderator only)."
  }),
  developer_identifier: z
    .string()
    .optional()
    .openapi({
      param: { name: "developer_identifier", in: "query" },
      description: "Public scope only"
    }),
  status: ExtensionStatusSchema.optional().openapi({
    param: { name: "status", in: "query" },
    description: "All scope only: published, delisted, or unpublished"
  }),
  q: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      param: { name: "q", in: "query" },
      description:
        "All scope only: case-insensitive substring match on the extension identifier"
    })
}).strict();

// Merged GET /extensions returns one of the two list shapes depending on
// ?scope=. A union (not two routes) because the only caller is controlled;
// public readers narrow on scope=public, owner/moderator tooling on
// scope=mine/all.
export const UnifiedExtensionListResponseSchema = z
  .object({
    result: z.array(
      z.union([ExtensionListItemSchema, OwnedExtensionListItemSchema])
    ),
    pagination: PaginationSchema
  })
  .openapi("UnifiedExtensionListResponse");

// Merged GET /extensions/{id} (optional auth, role-aware): anonymous or
// unrelated callers get the published projection, owners and moderators get
// the full Owned view including delisted state.
export const ExtensionDetailResponseSchema = z
  .object({ result: z.union([ExtensionSchema, OwnedExtensionSchema]) })
  .openapi("ExtensionDetailResponse");
