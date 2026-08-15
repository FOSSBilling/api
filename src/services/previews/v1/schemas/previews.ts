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
    commit_sha: z.string().nullable().openapi({
      description:
        "Commit that produced the current main preview, from R2 object custom metadata. null if the object predates that metadata being set - GitHub Actions enrichment below is skipped in that case too, since there's no commit to look it up by."
    }),
    short_sha: z.string().nullable(),
    pr_number: z.number().nullable().openapi({
      description:
        "Always null - main is never associated with a pull request. Present only for shape parity with the PR/commit response."
    }),
    // Enrichment from that commit's GitHub Actions artifact, when
    // resolvable - null if the commit has no known artifact (e.g. expired
    // past GitHub's 14-day retention) or GitHub is unavailable. Never
    // blocks or degrades the response: download_url/digest below are the
    // load-bearing, R2-sourced fields and don't depend on this resolving.
    run_id: z.number().nullable().openapi({
      description:
        "GitHub Actions run that produced this commit's preview artifact. null if that artifact isn't resolvable (not yet built, aged out of GitHub's 14-day retention, or GitHub unavailable) - this is best-effort enrichment, never required for the response to succeed."
    }),
    artifact_id: z.number().nullable().openapi({
      description:
        "GitHub Actions artifact ID for this commit's build. Same best-effort enrichment as run_id - null under the same conditions."
    }),
    created_at: z.string().nullable().openapi({
      description:
        "When the enrichment artifact was created. Same best-effort enrichment as run_id - null under the same conditions."
    }),
    expires_at: z.string().nullable().openapi({
      description:
        "When the enrichment artifact ages out of GitHub's retention. Same best-effort enrichment as run_id - null under the same conditions."
    }),
    digest: z.string().nullable().openapi({
      description:
        "SHA-256 digest (sha256:<hex>) of the R2-hosted zip, from R2 object custom metadata. null if the object predates that metadata being set."
    }),
    size_bytes: z.number(),
    last_modified: z.string(),
    download_url: z.string().openapi({
      description:
        "Permanent public download URL (download.fossbilling.org). Unlike the PR/commit equivalent, this never expires and is safe to embed directly rather than resolve through a redirect."
    }),
    source: z.literal("r2").openapi({
      description:
        'Always "r2" - describes where download_url/digest come from, independent of whether the GitHub Actions enrichment above resolved.'
    })
  })
  .openapi("MainPreview", {
    description:
      "Current main preview. download_url/digest are R2-sourced and always present once main has been published; run_id/artifact_id/created_at/expires_at are best-effort GitHub Actions enrichment that may be null."
  });

export const MainPreviewResponseSchema = z
  .object({ result: MainPreviewSchema })
  .openapi("MainPreviewResponse");

const ArtifactPreviewSchema = z
  .object({
    commit_sha: z.string(),
    short_sha: z.string(),
    pr_number: z.number().nullable().openapi({
      description:
        "Set only when resolved via /pr/{number} - a direct /commit/{sha} lookup has no way to know which PR (if any) built that commit, and reports null."
    }),
    run_id: z.number(),
    artifact_id: z.number().openapi({
      description:
        "GitHub Actions artifact ID - what /download resolves to a live signed URL."
    }),
    digest: z.string().nullable().openapi({
      description:
        "GitHub's own SHA-256 digest (sha256:<hex>) for this artifact - the exact bytes served by the /download route."
    }),
    size_bytes: z.number(),
    created_at: z.string(),
    expires_at: z.string().openapi({
      description:
        "When this artifact ages out of GitHub's 14-day retention. After this, /download starts returning 404 even if this metadata is still cached."
    }),
    download_url: z.string().openapi({
      description:
        "Self-referential - points at this service's own /commit/{sha}/download, not GitHub's actual signed URL (which expires in ~60s and can't be cached). Always the canonical commit URL, even when resolved via /pr/{number}, since a PR's head SHA moves as new commits land but a commit's build does not."
    }),
    source: z.literal("actions_artifact").openapi({
      description:
        'Always "actions_artifact" - distinguishes this from main\'s R2-sourced response.'
    })
  })
  .openapi("ArtifactPreview", {
    description:
      "Preview build for a specific commit or pull request, resolved from a GitHub Actions artifact."
  });

export const ArtifactPreviewResponseSchema = z
  .object({ result: ArtifactPreviewSchema })
  .openapi("ArtifactPreviewResponse");

export type MainPreview = z.infer<typeof MainPreviewSchema>;
export type ArtifactPreview = z.infer<typeof ArtifactPreviewSchema>;
