import { z } from "@hono/zod-openapi";
import {
  ManifestSchema as PackageManifestSchema,
  ManifestRequirementsSchema as PackageRequirementsSchema
} from "@fossbilling/extension-packaging/manifest";

export const ManifestRequirementsSchema = z
  .strictObject(PackageRequirementsSchema.shape)
  .openapi("ManifestRequirements");
export const ManifestSchema = z
  .strictObject({
    ...PackageManifestSchema.shape,
    requires: ManifestRequirementsSchema
  })
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
