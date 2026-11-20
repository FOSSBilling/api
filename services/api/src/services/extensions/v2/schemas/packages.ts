import { z } from "@hono/zod-openapi";
import { ManifestSchema } from "./manifest";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const PackageUploadRequestSchema = z.strictObject({
  manifest: ManifestSchema,
  bytes: z.number().int().min(1),
  sha256
});
export const PackageBuildSchema = z.union([
  z.strictObject({ upload_id: z.uuid() }),
  z.strictObject({ manifest: ManifestSchema, source_id: z.uuid() })
]);
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

export const PackageReservationSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upload"),
      id: z.uuid(),
      url: z.url(),
      headers: z.record(z.string(), z.string())
    }),
    z.object({ kind: z.literal("job"), job: PackagingJobSchema })
  ])
  .openapi("PackageReservation");
