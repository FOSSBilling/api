import { ArtifactPreview } from "./schemas/previews";
import {
  findPreviewArtifactByCommitSha,
  GithubLookupResult
} from "./github/artifacts";

export type PreviewLookupResult = GithubLookupResult<ArtifactPreview>;

// download_url always points at the canonical /commit/{full_sha}/download
// route, using the fully-resolved SHA rather than whatever prefix or PR
// number the caller looked it up by. A PR's head SHA moves as new commits
// land; a specific commit's build does not, so that's the one stable link
// to hand back regardless of which route resolved it.
export async function resolveArtifactPreview(
  githubToken: string,
  sha: string,
  prNumber: number | null
): Promise<PreviewLookupResult> {
  const found = await findPreviewArtifactByCommitSha(githubToken, sha);
  if (found.status !== "found") return found;

  const { data } = found;
  const preview: ArtifactPreview = {
    commit_sha: data.commitSha,
    short_sha: data.commitSha.slice(0, 7),
    pr_number: prNumber,
    run_id: data.runId,
    artifact_id: data.artifactId,
    digest: data.digest,
    size_bytes: data.sizeBytes,
    created_at: data.createdAt,
    expires_at: data.expiresAt,
    download_url: `/previews/v1/commit/${data.commitSha}/download`,
    source: "actions_artifact"
  };
  return { status: "found", data: preview };
}
