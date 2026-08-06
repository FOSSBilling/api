import { z } from "@hono/zod-openapi";

// Lowercase alphanumeric slug (hyphens allowed, no leading/trailing hyphen) —
// matches the shape of existing ids (e.g. "fossbilling") and rules out
// anything that isn't safe to use as a URL path segment or DOM identifier.
export const lowercaseId = (label: string) =>
  z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: `${label} id must be a lowercase alphanumeric slug`
  });

// Restricts to http(s) — z.string().url() alone accepts any scheme,
// including javascript:/data:, which is unsafe for fields a consumer may
// render as a link or image src.
export const httpUrl = () =>
  z
    .string()
    .max(2048)
    .url()
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "must use http or https"
    });

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      message: z.string(),
      code: z.string(),
      details: z
        .array(
          z.unknown().openapi({
            type: ["string", "number", "boolean", "object", "array", "null"]
          })
        )
        .optional()
    })
  })
  .openapi("Error");

// Every non-2xx response in this service carries ErrorResponseSchema and
// differs only by description, so routes declare them through this rather
// than restating the content block.
export const errorResponse = (description: string) =>
  ({
    content: { "application/json": { schema: ErrorResponseSchema } },
    description
  }) as const;

// All routes behind requireAuth() perform an active-account check after
// bearer authentication. Keep that response reusable so the generated
// contract documents the middleware failure consistently on every route.
export const ActiveAccountRequiredResponse = errorResponse(
  "The bearer is valid but the account is inactive"
);

export const IdParamSchema = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    example: "b6e2c9c4-3f1a-4e9b-9c3a-2e4b1a2f9d10"
  })
});

export const ReviewNoteOptionalSchema = z
  .object({
    review_note: z.string().max(2000).optional()
  })
  .strict()
  .openapi("ReviewNoteOptional");

export const ReviewNoteRequiredSchema = z
  .object({
    review_note: z.string().min(1).max(2000)
  })
  .strict()
  .openapi("ReviewNoteRequired");

export const PaginationSchema = z
  .object({
    next_cursor: z.string().nullable(),
    has_more: z.boolean()
  })
  .openapi("Pagination");
