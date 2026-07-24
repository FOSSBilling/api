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

const lowercaseId = (label: string) =>
  z
    .string()
    .min(1)
    .refine((value) => value === value.toLowerCase(), {
      message: `${label} id must be lowercase`
    });

export const AuthorSchema = z
  .object({
    id: lowercaseId("author"),
    type: z.enum(["user", "organization"]),
    name: z.string().min(1),
    url: z.string().url().optional()
  })
  .openapi("Author");

export const ReleaseSchema = z
  .object({
    tag: z.string().min(1),
    date: z.string().min(1),
    download_url: z.string().url(),
    changelog_url: z.string().url().optional(),
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
    URL: z.string().url().optional()
  })
  .openapi("License");

export const ExtensionPayloadSchema = z
  .object({
    id: lowercaseId("extension"),
    type: z.enum(EXTENSION_TYPES),
    name: z.string().min(1),
    description: z.string().min(1),
    releases: z.array(ReleaseSchema).min(1),
    website: z.string().url(),
    license: LicenseSchema,
    icon_url: z.string().url().optional(),
    readme: z.string().min(1),
    source: RepositorySchema,
    version: z.string().min(1),
    download_url: z.string().url()
  })
  .openapi("ExtensionPayload");

export const SubmissionPayloadSchema = z
  .object({
    author: AuthorSchema,
    extension: ExtensionPayloadSchema
  })
  .openapi("SubmissionPayload");

export type SubmissionPayload = z.infer<typeof SubmissionPayloadSchema>;

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
    author_id: z.string(),
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
      code: z.string()
    })
  })
  .openapi("Error");

export const IdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    example: "b6e2c9c4-3f1a-4e9b-9c3a-2e4b1a2f9d10"
  })
});

export const QueueQuerySchema = z.object({
  status: SubmissionStatusSchema.optional().openapi({
    param: { name: "status", in: "query" }
  })
});
