import { z } from "@hono/zod-openapi";
import { sortReleasesDescending } from "../../../lib/releases";
import { parseJSON } from "../../../lib/json";

export { sortReleasesDescending, parseJSON };

export const EXTENSION_TYPES = [
  "mod",
  "theme",
  "payment-gateway",
  "server-manager",
  "domain-registrar",
  "hook",
  "translation"
] as const;

// Lowercase alphanumeric slug (hyphens allowed, no leading/trailing hyphen) —
// matches the shape of existing ids (e.g. "fossbilling") and rules out
// anything that isn't safe to use as a URL path segment or DOM identifier.
const lowercaseId = (label: string) =>
  z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: `${label} id must be a lowercase alphanumeric slug`
  });

// Restricts to http(s) — z.string().url() alone accepts any scheme,
// including javascript:/data:, which is unsafe for fields a consumer may
// render as a link or image src.
const httpUrl = () =>
  z
    .string()
    .max(2048)
    .url()
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "must use http or https"
    });

// GET /developers/{id} is registered after the static single-segment
// GET /developers/* routes (claims, unapproved), so a developer whose id
// literally matched one of those words would always hit the static route
// instead — its public profile would be permanently unreachable there.
// Rejecting these ids at creation time (rather than trying to route around
// the collision) keeps every existing/future developer id resolvable.
const RESERVED_DEVELOPER_IDS = new Set(["claims", "unapproved"]);

const developerId = () =>
  lowercaseId("developer").refine((id) => !RESERVED_DEVELOPER_IDS.has(id), {
    message: "This developer id is reserved"
  });

export const DeveloperSchema = z
  .object({
    id: developerId(),
    type: z.enum(["user", "organization"]),
    name: z.string().min(1).max(120),
    URL: httpUrl().optional(),
    avatar_url: httpUrl().optional(),
    contact_email: z.string().email().max(254).optional()
  })
  .openapi("Developer");

export type Developer = z.infer<typeof DeveloperSchema>;

// Submissions go through moderation and only ever touch identity fields —
// profile fields (avatar_url/contact_email) are direct-write-only via
// PUT /developers/me, so this schema rejects them instead of silently
// accepting-then-dropping them when a submission is approved.
export const SubmissionDeveloperSchema = DeveloperSchema.pick({
  id: true,
  type: true,
  name: true,
  URL: true
})
  .strict()
  .openapi("SubmissionDeveloper");

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

export const SubmissionPayloadSchema = z
  .object({
    developer: SubmissionDeveloperSchema,
    extension: ExtensionPayloadSchema
  })
  .strict()
  .superRefine((payload, ctx) => {
    const size = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (size > 256 * 1024) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Submission payload must not exceed 256 KiB"
      });
    }
  })
  .openapi("SubmissionPayload");

export type SubmissionPayload = z.infer<typeof SubmissionPayloadSchema>;

export const DeveloperProfileSchema = DeveloperSchema.extend({
  approved: z.boolean(),
  content_revision: z.number().int().positive(),
  // Server-computed — see DevelopersDatabase.verifyGithubOwnership() (at
  // claim/creation time) and reverifyOwn() (opportunistic re-check on
  // login, or the owner's own "Re-verify" action). Never part of the
  // client-supplied DeveloperSchema.
  github_org_verified: z.boolean().optional(),
  github_verification_note: z.string().optional(),
  // Set whenever github_org_verified is last (re-)computed to a definitive
  // true/false — see reverifyOwn(). Absent/stale on an inconclusive check.
  github_verified_at: z.string().nullable().optional(),
  // Whether Publisher URL matches GitHub's own on-file website for this
  // org/user — see verifyGithubOwnership()'s urlMatchesGithubBlog() call.
  // Only ever true or absent (never false): GitHub's website field is
  // optional and often unset, so "doesn't match" isn't itself meaningful —
  // there's nothing to flag, unlike github_org_verified's identity check.
  // Computed at creation, and re-checked by the owner's own "Re-verify"
  // action (never by the opportunistic per-login re-check, which stays
  // GitHub-API-free by design).
  github_url_verified: z.boolean().optional(),
  // Only populated by the moderator listAll/listUnapproved queries (see
  // DevelopersDatabase.listAll/listUnapproved) — other DeveloperProfile
  // producers (getById, create/update/claim/transfer results) don't join
  // for it, so it's absent rather than null there. `unclaimed` is the
  // authoritative "has an owner" signal (owner_user_id IS NULL) — don't
  // infer ownership from owner_name being present, since a real owner can
  // still have a null name (e.g. their auth provider never supplied one).
  // Owner identity is never exposed publicly — see PublicDeveloperSchema
  // below and the README's note on not leaking owner identity.
  unclaimed: z.boolean().optional(),
  owner_name: z.string().nullable().optional(),
  owner_github_login: z.string().nullable().optional()
}).openapi("DeveloperProfile");

export type DeveloperProfile = z.infer<typeof DeveloperProfileSchema>;

// The publicly-readable view of a developer profile: everything in
// DeveloperProfile except contact_email/content_revision (moderator/owner
// only), the GitHub verification signal (a moderator-review aid, not meant
// for public consumption), and the owner's identity (only ever an
// `unclaimed` boolean is public — see src/lib/database.ts in the extensions
// repo).
export const PublicDeveloperSchema = DeveloperProfileSchema.omit({
  contact_email: true,
  content_revision: true,
  github_org_verified: true,
  github_verification_note: true,
  github_verified_at: true,
  github_url_verified: true,
  unclaimed: true,
  owner_name: true,
  owner_github_login: true
}).openapi("PublicDeveloper");

export type PublicDeveloper = z.infer<typeof PublicDeveloperSchema>;

export function toPublicDeveloper(profile: DeveloperProfile): PublicDeveloper {
  return {
    id: profile.id,
    type: profile.type,
    name: profile.name,
    URL: profile.URL,
    avatar_url: profile.avatar_url,
    approved: profile.approved
  };
}

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
    .max(1000)
    .optional()
    .openapi({
      param: { name: "cursor", in: "query" },
      description: "Opaque cursor returned by the previous page"
    })
});

export const ExtensionListResponseSchema = z
  .object({
    result: z.array(ExtensionListItemSchema),
    pagination: z.object({
      next_cursor: z.string().nullable(),
      has_more: z.boolean()
    })
  })
  .openapi("ExtensionListResponse");

export const DeveloperHistoryEntrySchema = z
  .object({
    developer_id: z.string(),
    type: z.enum(["user", "organization"]),
    name: z.string(),
    URL: httpUrl().optional(),
    changed_by: z.string(),
    // The editor's account name at read time — null if the auth provider
    // never gave one, or the users row was since deleted.
    changed_by_name: z.string().nullable(),
    changed_at: z.string()
  })
  .openapi("DeveloperHistoryEntry");

export type DeveloperHistoryEntry = z.infer<typeof DeveloperHistoryEntrySchema>;

export const ReviewNoteOptionalSchema = z
  .object({
    review_note: z.string().max(2000).optional()
  })
  .openapi("ReviewNoteOptional");

export const ReviewNoteRequiredSchema = z
  .object({
    review_note: z.string().min(1).max(2000)
  })
  .openapi("ReviewNoteRequired");

export const SubmissionStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected"
]);

export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;

export const SubmissionSchema = z
  .object({
    id: z.string(),
    extension_id: z.string().nullable(),
    developer_id: z.string(),
    submitted_by: z.string(),
    status: SubmissionStatusSchema,
    payload: SubmissionPayloadSchema,
    reviewer_id: z.string().nullable(),
    review_note: z.string().nullable(),
    created_at: z.string(),
    reviewed_at: z.string().nullable()
  })
  .openapi("Submission");

export type Submission = z.infer<typeof SubmissionSchema>;

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      message: z.string(),
      code: z.string(),
      details: z.array(z.unknown()).optional()
    })
  })
  .openapi("Error");

export const IdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    example: "b6e2c9c4-3f1a-4e9b-9c3a-2e4b1a2f9d10"
  })
});

export const TransferAcceptanceSchema = z
  .object({ token: z.string().min(64).max(128) })
  .strict()
  .openapi("TransferAcceptance");

export const DeveloperApprovalSchema = z
  .object({ expected_revision: z.number().int().positive() })
  .strict()
  .openapi("DeveloperApproval");

export const DeveloperTransferSchema = z
  .object({
    token: z.string(),
    expires_at: z.string()
  })
  .openapi("DeveloperTransfer");

export type DeveloperTransfer = z.infer<typeof DeveloperTransferSchema>;

export const DeveloperClaimSchema = z
  .object({
    id: z.string(),
    developer_id: z.string(),
    claimant_id: z.string(),
    status: z.enum(["pending", "approved", "rejected"]),
    note: z.string().optional(),
    review_note: z.string().optional(),
    reviewer_id: z.string().optional(),
    created_at: z.string(),
    reviewed_at: z.string().optional(),
    // Server-computed at claim() time only — never accepted from the
    // client (see ClaimNoteSchema below). Undefined when there was no
    // verifiable GitHub org/user for this id, or the claimant had no linked
    // GitHub identity yet; both fall back to manual moderator review rather
    // than gating anything.
    github_org_verified: z.boolean().optional(),
    github_verification_note: z.string().optional()
  })
  .openapi("DeveloperClaim");

export type DeveloperClaim = z.infer<typeof DeveloperClaimSchema>;

export const PendingDeveloperClaimSchema = DeveloperClaimSchema.extend({
  developer_name: z.string(),
  developer_type: z.enum(["user", "organization"]),
  // The claimant's own account name/GitHub handle, so the moderator sees
  // who's asking instead of just their opaque id. Null if the auth
  // provider never gave a name, or the claimant hasn't linked GitHub yet.
  claimant_name: z.string().nullable(),
  claimant_github_login: z.string().nullable()
}).openapi("PendingDeveloperClaim");

export type PendingDeveloperClaim = z.infer<typeof PendingDeveloperClaimSchema>;

export const ClaimNoteSchema = z
  .object({
    note: z.string().max(500).optional()
  })
  .openapi("ClaimNote");

// check_url — opt-in because it costs an extra GitHub API call (see
// DevelopersDatabase.reverifyOwn()); only the owner's own manual "Re-verify"
// button sets this, never the opportunistic per-login re-check. Not
// z.coerce.boolean(): that coerces the non-empty string "false" to true.
export const ReverifyQuerySchema = z.object({
  check_url: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
    .openapi({
      param: { name: "check_url", in: "query" }
    })
});

export const QueueQuerySchema = z.object({
  status: SubmissionStatusSchema.optional().openapi({
    param: { name: "status", in: "query" }
  }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .openapi({
      param: { name: "limit", in: "query" }
    }),
  cursor: z
    .string()
    .max(1000)
    .optional()
    .openapi({
      param: { name: "cursor", in: "query" }
    })
});

export const SubmissionPageQuerySchema = QueueQuerySchema.pick({
  limit: true,
  cursor: true
});

export const PaginationSchema = z
  .object({
    next_cursor: z.string().nullable(),
    has_more: z.boolean()
  })
  .openapi("Pagination");
