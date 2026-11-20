import { z } from "zod";
import { ManifestSchema } from "./manifest";
import { PACKAGE_LIMITS } from "./limits";

// Matches the sanitizer's maximum prepared SVG output.
export const MAX_PACKAGE_ICON_BYTES = 4 * 1024 * 1024;
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

export const ProcessingInputSchema = z
  .object({
    target: PackageTargetSchema,
    source: z.object({ id: z.uuid(), sha256: checksum }).strict(),
    archive: z.uuid(),
    icons: z.tuple([z.uuid(), z.uuid()])
  })
  .strict()
  .refine((value) => {
    const keys = [value.source.id, value.archive, ...value.icons];
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
