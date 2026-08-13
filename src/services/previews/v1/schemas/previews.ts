import { z } from "@hono/zod-openapi";

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      message: z.string(),
      code: z.string(),
      // Only present on 422s - index.ts's defaultHook attaches the zod
      // validation issues here for VALIDATION_ERROR responses.
      details: z
        .array(
          z.unknown().openapi({
            type: ["string", "number", "boolean", "object", "array", "null"]
          })
        )
        .optional()
    })
  })
  .openapi("Error");

// Every non-2xx response in this service carries ErrorResponseSchema and
// differs only by description, mirroring extensions/v2's schemas/common.ts.
export const errorResponse = (description: string) =>
  ({
    content: { "application/json": { schema: ErrorResponseSchema } },
    description
  }) as const;

export const PrNumberParamSchema = z.object({
  number: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: "number", in: "path" },
      example: 123
    })
});

// Full or abbreviated (7+ char) hex commit SHA - GitHub accepts either as a
// git ref, and workflow_run.head_sha in the artifacts API is always the full
// 40-char form, so a short SHA here is matched as a prefix by the resolver.
export const CommitShaParamSchema = z.object({
  sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, { message: "must be a hex commit SHA" })
    .openapi({
      param: { name: "sha", in: "path" },
      example: "a1b2c3d"
    })
});

const MainPreviewSchema = z
  .object({
    commit_sha: z.string().nullable(),
    short_sha: z.string().nullable(),
    // Always null - main isn't a PR. Present for shape parity with
    // ArtifactPreview.
    pr_number: z.number().nullable(),
    // Enrichment from that commit's GitHub Actions artifact, when
    // resolvable - null if the commit has no known artifact (e.g. expired
    // past GitHub's 14-day retention) or GitHub is unavailable. Never
    // blocks or degrades the response: download_url/digest below are the
    // load-bearing, R2-sourced fields and don't depend on this resolving.
    run_id: z.number().nullable(),
    artifact_id: z.number().nullable(),
    created_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    digest: z.string().nullable(),
    size_bytes: z.number(),
    last_modified: z.string(),
    download_url: z.string(),
    source: z.literal("r2")
  })
  .openapi("MainPreview");

export const MainPreviewResponseSchema = z
  .object({ result: MainPreviewSchema })
  .openapi("MainPreviewResponse");

const ArtifactPreviewSchema = z
  .object({
    commit_sha: z.string(),
    short_sha: z.string(),
    pr_number: z.number().nullable(),
    run_id: z.number(),
    artifact_id: z.number(),
    digest: z.string().nullable(),
    size_bytes: z.number(),
    created_at: z.string(),
    expires_at: z.string(),
    download_url: z.string(),
    source: z.literal("actions_artifact")
  })
  .openapi("ArtifactPreview");

export const ArtifactPreviewResponseSchema = z
  .object({ result: ArtifactPreviewSchema })
  .openapi("ArtifactPreviewResponse");

export type MainPreview = z.infer<typeof MainPreviewSchema>;
export type ArtifactPreview = z.infer<typeof ArtifactPreviewSchema>;
