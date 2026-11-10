import { z } from "zod";
import { ManifestSchema } from "./manifest";
import { PACKAGE_LIMITS } from "./limits";

export const MAX_PACKAGE_OBJECT_BYTES =
  PACKAGE_LIMITS.expandedBytes + 1024 * 1024;
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const output = z
  .object({
    bytes: z.number().int().positive().max(MAX_PACKAGE_OBJECT_BYTES),
    sha256: checksum
  })
  .strict();
export const ProcessingInputSchema = z
  .object({
    manifest: ManifestSchema,
    source: z.object({ id: z.uuid(), sha256: checksum }).strict(),
    archive: z.uuid(),
    icons: z.tuple([z.uuid(), z.uuid()]).optional()
  })
  .strict()
  .refine((value) => {
    const keys = [value.source.id, value.archive, ...(value.icons ?? [])];
    return new Set(keys).size === keys.length;
  }, "Processing object IDs must be distinct");
export const ProcessingResultSchema = z
  .object({
    archive: output,
    icons: z
      .array(
        output
          .extend({
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
