import { z } from "@hono/zod-openapi";
import { SubmissionDeveloperSchema } from "./developers";
import { ExtensionPayloadSchema, isReservedExtensionId } from "./extensions";

export const SubmissionPayloadSchema = z
  .object({
    developer: SubmissionDeveloperSchema,
    extension: ExtensionPayloadSchema
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (isReservedExtensionId(payload.extension.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "This extension id is reserved",
        path: ["extension", "id"]
      });
    }
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

export const SubmissionPageQuerySchema = QueueQuerySchema.pick({
  limit: true,
  cursor: true
});
