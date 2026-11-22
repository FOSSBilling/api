import { z } from "zod";
import { ManifestSchema } from "./manifest";
import { PACKAGE_LIMITS } from "./limits";

// Matches the sanitizer's maximum prepared SVG output.
export const MAX_PACKAGE_ICON_BYTES = 4 * 1024 * 1024;
export const GITHUB_AUTHORIZATION_HEADER = "X-GitHub-Authorization";
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const output = z
  .object({
    bytes: z.number().int().positive(),
    sha256: checksum
  })
  .strict();
export const PackageTargetSchema = z
  .strictObject({
    id: ManifestSchema.shape.id.optional(),
    version: ManifestSchema.shape.version.optional()
  })
  .refine(({ id, version }) => id !== undefined || version === undefined, {
    path: ["id"],
    message: "Extension ID is required when a version is supplied"
  });
export type PackageTarget = z.infer<typeof PackageTargetSchema>;

const StoredPackageSourceSchema = z.strictObject({
  id: z.uuid(),
  sha256: checksum
});
export const GitHubPackageSourceSchema = z.strictObject({
  github: z.strictObject({
    repository: z.string().regex(/^[a-z0-9-]+\/[a-z0-9_.-]+$/u),
    assetId: z.number().int().positive(),
    bytes: z.number().int().positive().max(PACKAGE_LIMITS.sourceBytes)
  }),
  sha256: checksum
});
export type GitHubPackageSource = z.infer<typeof GitHubPackageSourceSchema>;
const PackageSourceSchema = z.union([
  StoredPackageSourceSchema,
  GitHubPackageSourceSchema
]);
export type PackageSource = z.infer<typeof PackageSourceSchema>;

export const ProcessingInputSchema = z
  .object({
    target: PackageTargetSchema,
    source: PackageSourceSchema,
    archive: z.uuid(),
    icons: z.tuple([z.uuid(), z.uuid()])
  })
  .strict()
  .refine((value) => {
    const keys = [value.archive, ...value.icons];
    if ("id" in value.source) keys.push(value.source.id);
    return new Set(keys).size === keys.length;
  }, "Processing object IDs must be distinct");
export const ProcessingResultSchema = z
  .object({
    manifest: ManifestSchema,
    archive: output.extend({
      bytes: output.shape.bytes.max(PACKAGE_LIMITS.sourceBytes)
    }),
    icons: z
      .array(
        output
          .extend({
            bytes: output.shape.bytes.max(MAX_PACKAGE_ICON_BYTES),
            id: z.uuid(),
            format: z.enum(["svg", "avif", "png"])
          })
          .strict()
      )
      .max(2)
  })
  .strict()
  .refine((value) => {
    const formats = value.icons
      .map((icon) => icon.format)
      .sort()
      .join(",");
    return formats === "" || formats === "svg" || formats === "avif,png";
  }, "Invalid prepared icon variants");
export type ProcessingInput = z.infer<typeof ProcessingInputSchema>;
export type ProcessingResult = z.infer<typeof ProcessingResultSchema>;

// Storage keys and manifests are provider-neutral; the runner never needs a database binding.
export interface PackageProcessor {
  process(input: ProcessingInput): Promise<ProcessingResult>;
}
