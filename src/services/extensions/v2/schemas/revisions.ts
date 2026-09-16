import { z } from "@hono/zod-openapi";
import { StoredExtensionContentSchema } from "./extensions";

export const RevisionStatusSchema = z.enum(["pending", "approved", "rejected"]);

export type RevisionStatus = z.infer<typeof RevisionStatusSchema>;

// A proposed version of one extension's content. No developer fields: that is
// fixed by the extension, and developer edits go through PUT /developers/me.
export const ExtensionRevisionSchema = z
  .object({
    id: z.string(),
    extension_id: z.string(),
    developer_id: z.string(),
    submitted_by: z.string(),
    status: RevisionStatusSchema,
    content: StoredExtensionContentSchema,
    reviewer_id: z.string().nullable(),
    review_note: z.string().nullable(),
    created_at: z.string(),
    reviewed_at: z.string().nullable()
  })
  .openapi("ExtensionRevision");

export type ExtensionRevision = z.infer<typeof ExtensionRevisionSchema>;

export const RevisionIdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    example: "acme-gateway"
  }),
  revisionId: z.string().openapi({
    param: { name: "revisionId", in: "path" },
    example: "b6e2c9c4-3f1a-4e9b-9c3a-2e4b1a2f9d10"
  })
});

export const RevisionQueueQuerySchema = z.object({
  status: RevisionStatusSchema.optional().openapi({
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
  // min(1) matches ExtensionListQuerySchema: without it `?cursor=` arrives as
  // an empty string, which the page helper treats as "no cursor" and silently
  // restarts pagination instead of reporting the malformed value.
  cursor: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .openapi({
      param: { name: "cursor", in: "query" }
    })
});

// Unified query for the merged GET /revisions (optional auth, role-aware).
// extension_id set: per-extension history (owner-or-moderator), newest first.
// extension_id unset: global moderation queue (moderator only), oldest first.
// status filters in both modes; sort overrides the mode default.
export const UnifiedRevisionsQuerySchema = RevisionQueueQuerySchema.extend({
  // No max: extension ids are unbounded slugs (lowercaseId), so capping
  // this query param could reject a valid id before lookup.
  extension_id: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "extension_id", in: "query" },
      description:
        "When set, list that extension's history; when omitted, list the global review queue (moderator only)"
    }),
  sort: z
    .enum(["newest", "oldest"])
    .optional()
    .openapi({
      param: { name: "sort", in: "query" },
      description:
        "Override the default order (per-extension: newest first, queue: oldest first)"
    })
});
