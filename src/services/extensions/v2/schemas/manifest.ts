import { z } from "@hono/zod-openapi";
import { httpUrl } from "./common";

// Package metadata follows FOSSBilling/modules manifest.schema.json (v1).
// Package paths are kept relative; serving an icon is a publisher concern.
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
    php: versionConstraint,
    modules: z
      .record(z.string().regex(/^[a-z0-9_-]+$/), versionConstraint)
      .optional()
  })
  .strict()
  .openapi("ManifestRequirements");

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
    icon_url: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^(?!\/)(?![a-zA-Z][a-zA-Z0-9+.-]*:)(?!.*\.\.)[^\\]+$/)
      .optional(),
    requires: ManifestRequirementsSchema
  })
  .strict()
  .openapi("Manifest");

export type Manifest = z.infer<typeof ManifestSchema>;

export function manifestMetadata(
  content: Pick<Manifest, "manifest_version" | "author" | "requires">
) {
  return {
    manifest_version: content.manifest_version,
    author: content.author,
    requires: content.requires
  };
}
