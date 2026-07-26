import { z } from "@hono/zod-openapi";

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
    .url()
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "must use http or https"
    });

export const DeveloperSchema = z
  .object({
    id: lowercaseId("developer"),
    type: z.enum(["user", "organization"]),
    name: z.string().min(1),
    URL: httpUrl().optional(),
    bio: z.string().max(500).optional(),
    avatar_url: httpUrl().optional(),
    contact_email: z.string().email().optional()
  })
  .openapi("Developer");

export type Developer = z.infer<typeof DeveloperSchema>;

// Submissions go through moderation and only ever touch identity fields —
// profile fields (bio/avatar_url/contact_email) are direct-write-only via
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
    tag: z.string().min(1),
    date: z.string().min(1),
    download_url: httpUrl(),
    changelog_url: httpUrl().optional(),
    min_fossbilling_version: z.string().min(1)
  })
  .openapi("Release");

export const RepositorySchema = z
  .object({
    type: z.enum(["github", "gitlab", "custom"]),
    repo: z.string().min(1)
  })
  .openapi("Repository");

export const LicenseSchema = z
  .object({
    name: z.string().min(1),
    URL: httpUrl().optional()
  })
  .openapi("License");

export const ExtensionPayloadSchema = z
  .object({
    id: lowercaseId("extension"),
    type: z.enum(EXTENSION_TYPES),
    name: z.string().min(1),
    description: z.string().min(1),
    releases: z.array(ReleaseSchema).min(1),
    website: httpUrl(),
    license: LicenseSchema,
    icon_url: httpUrl().optional(),
    readme: z.string().min(1),
    source: RepositorySchema,
    version: z.string().min(1),
    download_url: httpUrl()
  })
  .openapi("ExtensionPayload");

export const SubmissionPayloadSchema = z
  .object({
    developer: SubmissionDeveloperSchema,
    extension: ExtensionPayloadSchema
  })
  .openapi("SubmissionPayload");

export type SubmissionPayload = z.infer<typeof SubmissionPayloadSchema>;

export const DeveloperProfileSchema = DeveloperSchema.extend({
  approved: z.boolean()
}).openapi("DeveloperProfile");

export type DeveloperProfile = z.infer<typeof DeveloperProfileSchema>;

export const DeveloperHistoryEntrySchema = z
  .object({
    developer_id: z.string(),
    type: z.enum(["user", "organization"]),
    name: z.string(),
    URL: httpUrl().optional(),
    changed_by: z.string(),
    changed_at: z.string()
  })
  .openapi("DeveloperHistoryEntry");

export type DeveloperHistoryEntry = z.infer<typeof DeveloperHistoryEntrySchema>;

export const ReviewNoteOptionalSchema = z
  .object({
    review_note: z.string().optional()
  })
  .openapi("ReviewNoteOptional");

export const ReviewNoteRequiredSchema = z
  .object({
    review_note: z.string().min(1)
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

export const TokenParamSchema = z.object({
  token: z
    .string()
    .min(1)
    .openapi({
      param: { name: "token", in: "path" }
    })
});

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
    reviewed_at: z.string().optional()
  })
  .openapi("DeveloperClaim");

export type DeveloperClaim = z.infer<typeof DeveloperClaimSchema>;

export const PendingDeveloperClaimSchema = DeveloperClaimSchema.extend({
  developer_name: z.string(),
  developer_type: z.enum(["user", "organization"])
}).openapi("PendingDeveloperClaim");

export type PendingDeveloperClaim = z.infer<typeof PendingDeveloperClaimSchema>;

export const ClaimNoteSchema = z
  .object({
    note: z.string().max(500).optional()
  })
  .openapi("ClaimNote");

export const QueueQuerySchema = z.object({
  status: SubmissionStatusSchema.optional().openapi({
    param: { name: "status", in: "query" }
  })
});
