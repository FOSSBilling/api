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
    // Shown to the submitter as-is, so a whitespace-only value must not
    // satisfy min(1) the way an untrimmed string would - see DelistReasonSchema.
    review_note: z.string().trim().min(1).max(2000)
  })
  .strict()
  .openapi("ReviewNoteRequired");

export const DelistReasonSchema = z
  .object({
    // Shown to the owner as-is, so a whitespace-only value must not satisfy
    // min(1) the way an untrimmed string would.
    reason: z.string().trim().min(1).max(2000)
  })
  .strict()
  .openapi("DelistReason");

// Manual moderator opt-out for author notification emails (?notify=false).
// Absent — the checkbox-checked default in the directory UI — sends.
export const NotifyQuerySchema = z.object({
  notify: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      param: { name: "notify", in: "query" },
      description:
        "Set to false to skip the author notification email for this action"
    })
});

export const PaginationSchema = z
  .object({
    next_cursor: z.string().nullable(),
    has_more: z.boolean()
  })
  .openapi("Pagination");

// Opt-in offset pagination for the moderator/audit list endpoints: offset
// without limit is rejected (422) rather than silently ignored, since the
// generated schema would otherwise advertise a param the routes drop.
// Params entirely omitted fall back to a bounded default window - these
// lists are moderator-only, developer_history is append-only, and
// "no params" previously meant streaming every row. Callers that want
// everything page through with limit=100; the response envelope reports
// has_more either way.
export const offsetRequiresLimit = (query: {
  limit?: number;
  offset?: number;
}): boolean => query.limit !== undefined || query.offset === undefined;

export const ListPaginationQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .openapi({ param: { name: "limit", in: "query" } }),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .openapi({ param: { name: "offset", in: "query" } })
  })
  .refine(offsetRequiresLimit, {
    message: "offset requires limit"
  });

export const OffsetPaginationSchema = z
  .object({
    limit: z.number().int(),
    offset: z.number().int(),
    has_more: z.boolean()
  })
  .openapi("OffsetPagination");

// Normalises the validated pagination query into the shape the database
// readers take: offset defaults to 0, and params entirely omitted fall back
// to a bounded default window (see the contract note above) instead of an
// unbounded read.
const DEFAULT_OFFSET_PAGE = { limit: 100, offset: 0 };

export function offsetPageFromQuery(query: {
  limit?: number;
  offset?: number;
}): { limit: number; offset: number } {
  return {
    limit: query.limit ?? DEFAULT_OFFSET_PAGE.limit,
    offset: query.offset ?? 0
  };
}

// The response half of the same deal: the OffsetPagination envelope,
// reporting the applied window and whether more rows follow it.
export function offsetPaginationFrom(
  page: { limit: number; offset: number },
  hasMore: boolean
): { limit: number; offset: number; has_more: boolean } {
  return { ...page, has_more: hasMore };
}
