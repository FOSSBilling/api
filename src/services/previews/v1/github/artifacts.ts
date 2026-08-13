import { request as ghRequest } from "@octokit/request";
import {
  classifyGitHubError,
  GitHubError,
  NotFoundError
} from "../../../../lib/github-errors";
import { logWarn } from "../../../../lib/logger";

// FOSSBilling/FOSSBilling's ci.yml uploads one unified artifact under this
// name for every PR build, non-main branch push, and main push - see
// upload-preview in that repo's .github/workflows/ci.yml.
const REPO_OWNER = "FOSSBilling";
const REPO_NAME = "FOSSBilling";
const PREVIEW_ARTIFACT_NAME = "FOSSBilling Preview";

export interface PreviewArtifact {
  runId: number;
  artifactId: number;
  commitSha: string;
  digest: string | null;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
}

export type GithubLookupResult<T> =
  | { status: "found"; data: T }
  | { status: "not_found" }
  | { status: "unavailable"; error: GitHubError };

interface RawArtifact {
  id: number;
  size_in_bytes: number;
  created_at: string | null;
  expires_at: string | null;
  expired: boolean;
  digest: string | null;
  workflow_run?: {
    id: number;
    head_sha: string;
  } | null;
}

function unavailable<T>(
  context: string,
  error: unknown,
  url: string
): GithubLookupResult<T> {
  const githubError = classifyGitHubError(error, url);
  logWarn("previews", `${context} unavailable`, {
    message: githubError.message,
    httpStatus: githubError.httpStatus
  });
  return { status: "unavailable", error: githubError };
}

// Lists artifacts named `FOSSBilling Preview` (server-side filtered, so the
// result set is bounded to one live artifact per recent successful run
// rather than the repo's entire artifact history) and returns the newest
// non-expired one whose triggering run built the given commit.
export async function findPreviewArtifactByCommitSha(
  githubToken: string,
  sha: string
): Promise<GithubLookupResult<PreviewArtifact>> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/artifacts`;
  try {
    const result = await ghRequest(
      "GET /repos/{owner}/{repo}/actions/artifacts",
      {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        name: PREVIEW_ARTIFACT_NAME,
        per_page: 100,
        headers: { Authorization: `Bearer ${githubToken}` }
      }
    );

    const artifacts = result.data.artifacts as RawArtifact[];
    const shaLower = sha.toLowerCase();
    let match: RawArtifact | null = null;

    for (const artifact of artifacts) {
      if (artifact.expired || !artifact.workflow_run) continue;
      if (!artifact.workflow_run.head_sha.toLowerCase().startsWith(shaLower)) {
        continue;
      }
      if (!match || (artifact.created_at ?? "") > (match.created_at ?? "")) {
        match = artifact;
      }
    }

    if (!match || !match.workflow_run) {
      return { status: "not_found" };
    }

    return {
      status: "found",
      data: {
        runId: match.workflow_run.id,
        artifactId: match.id,
        commitSha: match.workflow_run.head_sha,
        digest: match.digest ?? null,
        sizeBytes: match.size_in_bytes,
        createdAt: match.created_at ?? "",
        expiresAt: match.expires_at ?? ""
      }
    };
  } catch (error) {
    return unavailable("Preview artifact lookup", error, url);
  }
}

// Resolves a PR number to its current head commit SHA.
export async function resolvePullRequestHeadSha(
  githubToken: string,
  prNumber: number
): Promise<GithubLookupResult<string>> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${prNumber}`;
  try {
    const result = await ghRequest(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        pull_number: prNumber,
        headers: { Authorization: `Bearer ${githubToken}` }
      }
    );
    return { status: "found", data: result.data.head.sha };
  } catch (error) {
    const githubError = classifyGitHubError(error, url);
    if (githubError instanceof NotFoundError) return { status: "not_found" };
    return unavailable("Pull request lookup", error, url);
  }
}

// Resolves an artifact's live, short-lived download URL. Mirrors
// download-worker/src/preview.ts's getArtifactDownloadUrl - GitHub answers
// with a 302 to a signed, temporary URL rather than the file itself.
export async function getArtifactDownloadUrl(
  githubToken: string,
  artifactId: number
): Promise<GithubLookupResult<string>> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/artifacts/${artifactId}/zip`;
  try {
    const result = await ghRequest(
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
      {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        artifact_id: artifactId,
        archive_format: "zip",
        request: { redirect: "manual" },
        headers: { Authorization: `Bearer ${githubToken}` }
      }
    );

    if (result.status === 302 && result.headers.location) {
      return { status: "found", data: result.headers.location };
    }
    return unavailable(
      "Artifact download redirect",
      new Error(`Unexpected status ${result.status}`),
      url
    );
  } catch (error) {
    const githubError = classifyGitHubError(error, url);
    if (githubError instanceof NotFoundError) return { status: "not_found" };
    return unavailable("Artifact download redirect", error, url);
  }
}
