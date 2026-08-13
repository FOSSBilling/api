import { request as ghRequest } from "@octokit/request";
import {
  classifyGitHubError,
  GitHubError,
  NotFoundError
} from "../../../../lib/github-errors";
import { logWarn } from "../../../../lib/logger";

const REPO_OWNER = "FOSSBilling";
const REPO_NAME = "FOSSBilling";

// FOSSBilling/FOSSBilling's ci.yml uploads one artifact per commit for
// every PR build, non-main branch push, and main push - named after that
// commit's short SHA (archive: false, so the file's own basename becomes
// the artifact name - see upload-preview in that repo's
// .github/workflows/ci.yml). Querying by the exact name this produces
// returns at most the handful of runs that ever targeted this one commit,
// rather than every preview artifact in the retention window.
function artifactNameForSha(sha: string): string {
  return `FOSSBilling-preview-${sha.slice(0, 7)}.zip`;
}

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

// Queries the exact artifact name this commit's build would have produced
// (see artifactNameForSha) and returns the newest non-expired match. The
// head_sha check below is defense against a short-SHA collision, not the
// primary matching mechanism - the name filter already does that.
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
        name: artifactNameForSha(sha),
        per_page: 100,
        headers: { Authorization: `Bearer ${githubToken}` }
      }
    );

    const artifacts = result.data.artifacts as RawArtifact[];
    const shaLower = sha.toLowerCase();
    let match: {
      artifact: RawArtifact;
      runId: number;
      headSha: string;
    } | null = null;

    for (const artifact of artifacts) {
      const workflowRun = artifact.workflow_run;
      if (artifact.expired || !workflowRun) continue;
      if (!workflowRun.head_sha.toLowerCase().startsWith(shaLower)) continue;
      if (
        !match ||
        (artifact.created_at ?? "") > (match.artifact.created_at ?? "")
      ) {
        match = {
          artifact,
          runId: workflowRun.id,
          headSha: workflowRun.head_sha
        };
      }
    }

    if (!match) {
      return { status: "not_found" };
    }

    return {
      status: "found",
      data: {
        runId: match.runId,
        artifactId: match.artifact.id,
        commitSha: match.headSha,
        digest: match.artifact.digest ?? null,
        sizeBytes: match.artifact.size_in_bytes,
        createdAt: match.artifact.created_at ?? "",
        expiresAt: match.artifact.expires_at ?? ""
      }
    };
  } catch (error) {
    return unavailable("Preview artifact lookup", error, url);
  }
}

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
