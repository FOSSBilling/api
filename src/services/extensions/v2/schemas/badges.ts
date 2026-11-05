import { z } from "@hono/zod-openapi";
import { IdParamSchema } from "./common";
import { ManifestRequirementsSchema } from "./manifest";

export const BadgeParamsSchema = IdParamSchema.extend({
  type: z.enum(["version", "fossbilling", "license"]).openapi({
    param: { name: "type", in: "path" },
    description:
      "Latest release version, full FOSSBilling requirement, or license"
  })
});

export const BadgeQuerySchema = z.object({
  color: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .openapi({
      param: { name: "color", in: "query" },
      example: "green"
    })
});

export const BadgeDataSchema = z.object({
  license: z.string().min(1).max(1000),
  releases: z
    .array(
      z.object({
        tag: z
          .string()
          .min(1)
          .max(200)
          .refine((tag) => Array.from(tag).length <= 100),
        requires: z.object({
          fossbilling: ManifestRequirementsSchema.shape.fossbilling
        })
      })
    )
    .max(100)
});
