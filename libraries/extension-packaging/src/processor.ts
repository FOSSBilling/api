import { z } from "zod";
import { ManifestSchema } from "./manifest";
import { PACKAGE_LIMITS } from "./limits";
import type { IconVariant } from "./images";

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
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

export const GitHubPackageSourceSchema = z.strictObject({
  github: z.strictObject({
    repository: z.string().regex(/^[a-z0-9-]+\/[a-z0-9_.-]+$/u),
    assetId: z.number().int().positive(),
    bytes: z.number().int().positive().max(PACKAGE_LIMITS.sourceBytes)
  }),
  sha256: checksum
});
export type GitHubPackageSource = z.infer<typeof GitHubPackageSourceSchema>;
export type PackageSource =
  { id: string; sha256: string } | GitHubPackageSource;

export interface ProcessingInput {
  target: PackageTarget;
  source: PackageSource;
  archive: string;
}

export interface ProcessingResult {
  manifest: z.infer<typeof ManifestSchema>;
  archiveBytes: number;
  icons: IconVariant[];
}

// Storage keys and manifests are provider-neutral; the runner never needs a database binding.
export interface PackageProcessor {
  process(input: ProcessingInput): Promise<ProcessingResult>;
}
