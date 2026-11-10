import { z } from "@hono/zod-openapi";
import { ManifestSchema } from "./manifest";

export const PackageBuildSchema = z
  .object({
    manifest: z
      .string()
      .min(1)
      .max(64 * 1024)
      .describe("JSON manifest v1"),
    source: z
      .instanceof(File)
      .optional()
      .openapi({ type: "string", format: "binary" }),
    source_id: z.uuid().optional()
  })
  .strict()
  .refine(
    (value) => Boolean(value.source) !== Boolean(value.source_id),
    "Supply either a source ZIP or a stored source_id"
  );
export const PackageParamSchema = z.object({ packageId: z.uuid() });
export const PackageArtifactSchema = z
  .object({
    id: z.uuid(),
    source_id: z.uuid(),
    manifest: ManifestSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    download_url: z.url(),
    published_at: z.string().nullable(),
    created_at: z.string()
  })
  .openapi("PackageArtifact");

export const PackagingJobParamSchema = z.object({ jobId: z.uuid() });
export const PackagingJobSchema = z
  .object({
    id: z.uuid(),
    extension_identifier: z.string(),
    status: z.enum(["queued", "processing", "ready", "failed"]),
    artifact: z.union([PackageArtifactSchema, z.null()]),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        status: z.number().int()
      })
      .nullable(),
    created_at: z.string(),
    updated_at: z.string()
  })
  .openapi("PackagingJob");
