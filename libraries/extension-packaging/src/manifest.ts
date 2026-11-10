import { z } from "zod";
import { httpUrl } from "./urls";

// Package metadata follows FOSSBilling/modules manifest.schema.json (v1).
// Icons use fixed filenames at the package root, outside the manifest.
export const MANIFEST_EXTENSION_TYPES = [
  "module",
  "theme",
  "payment-gateway",
  "server-manager",
  "domain-registrar",
  "translation"
] as const;

const versionConstraint = z
  .string()
  .min(1)
  .max(1000)
  .regex(/\S/, "must contain a version constraint");

export const ManifestRequirementsSchema = z
  .object({
    fossbilling: versionConstraint,
    php: versionConstraint
      .optional()
      .describe(
        "Additional PHP constraint; when omitted, FOSSBilling runtime requirements apply"
      ),
    modules: z
      .record(z.string().regex(/^[a-z0-9_-]+$/), versionConstraint)
      .optional()
  })
  .strict();

export const ManifestSchema = z
  .object({
    manifest_version: z.literal(1),
    type: z.enum(MANIFEST_EXTENSION_TYPES),
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/),
    name: z.string().min(1).max(100),
    version: z
      .string()
      .max(100)
      .regex(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
      ),
    description: z.string().min(1).max(500),
    author: z
      .object({ name: z.string().min(1).max(200), url: httpUrl().optional() })
      .strict(),
    license: z
      .string()
      .min(1)
      .max(1000)
      .regex(/^[A-Za-z0-9.\-+_:() |]+$/),
    homepage_url: httpUrl().optional(),
    requires: ManifestRequirementsSchema
  })
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;
