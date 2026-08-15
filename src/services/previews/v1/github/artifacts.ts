import { request as ghRequest } from "@octokit/request";
import {
  classifyGitHubError,
  GitHubError,
  NotFoundError
} from "../../../../lib/github-errors";
import { logWarn } from "../../../../lib/logger";

const REPO_OWNER = "FOSSBilling";
const REPO_NAME = "FOSSBilling";
const ARTIFACT_NAME_PREFIX = "FOSSBilling-preview-";

// FOSSBilling/FOSSBilling's ci.yml uploads one artifact per commit for
// every PR build, non-main branch push, and main push - named after the
// short form of $GITHUB_SHA at build time (archive: false, so the file's
// own basename becomes the artifact name). Expects an already-lowercased
// sha - see findPreviewArtifactByCommitSha, which is the only caller.
function artifactNameForSha(shaLower: string): string {
  return `${ARTIFACT_NAME_PREFIX}${shaLower.slice(0, 7)}.zip`;
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
  name?: string;
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

async function listArtifacts(
  githubToken: string,
  name: string | undefined,
  page: number = 1
): Promise<RawArtifact[]> {
  const result = await ghRequest(
    "GET /repos/{owner}/{repo}/actions/artifacts",
    {
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ...(name ? { name } : {}),
      per_page: 100,
      page,
      headers: { Authorization: `Bearer ${githubToken}` }
    }
  );
  return result.data.artifacts as RawArtifact[];
}

// Bounds the fallback scan's worst case to 500 artifacts (5 pages x 100)
// rather than paginating through a repo's entire artifact history. Preview
// artifacts alone rarely approach that within GitHub's 14-day retention,
// even for an active repo.
const MAX_FALLBACK_PAGES = 5;

// The fallback path (see findPreviewArtifactByCommitSha) can't filter
// server-side by name, so a repo with more than one page of live preview
// artifacts would silently miss a genuine match sitting on page 2+ with a
// single unpaginated call. Pages through until a match is found or the
// list runs out.
async function findInFallbackPages(
  githubToken: string,
  shaLower: string
): Promise<{ artifact: RawArtifact; runId: number; headSha: string } | null> {
  for (let page = 1; page <= MAX_FALLBACK_PAGES; page++) {
    const artifacts = await listArtifacts(githubToken, undefined, page);
    const match = matchArtifact(
      artifacts.filter((artifact) =>
        artifact.name?.startsWith(ARTIFACT_NAME_PREFIX)
      ),
      shaLower
    );
    if (match) return match;
    if (artifacts.length < 100) break; // last page
  }
  return null;
}

// Newest non-expired artifact whose triggering run's real head commit
// matches shaLower. shaLower may be a short (7+ char) prefix, so this is
// a startsWith rather than an exact match.
function matchArtifact(
  artifacts: RawArtifact[],
  shaLower: string
): { artifact: RawArtifact; runId: number; headSha: string } | null {
  let match: { artifact: RawArtifact; runId: number; headSha: string } | null =
    null;

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

  return match;
}

function toPreviewArtifact(match: {
  artifact: RawArtifact;
  runId: number;
  headSha: string;
}): PreviewArtifact {
  return {
    runId: match.runId,
    artifactId: match.artifact.id,
    commitSha: match.headSha,
    digest: match.artifact.digest ?? null,
    sizeBytes: match.artifact.size_in_bytes,
    createdAt: match.artifact.created_at ?? "",
    expiresAt: match.artifact.expires_at ?? ""
  };
}

// Resolves the preview artifact for a commit. Tries the exact artifact
// name first (artifactNameForSha) - correct and cheap for push-triggered
// builds (main, branch pushes, and same-repo PRs, which take the push
// path since preview-build-pr is fork-only), where $GITHUB_SHA in CI is
// the actual pushed commit.
//
// Falls back to paging through every preview artifact (findInFallbackPages)
// and matching by the triggering run's real head_sha if that misses. This
// is what makes fork PRs resolve correctly: GitHub's pull_request event
// makes $GITHUB_SHA the ephemeral merge commit rather than the PR's real
// head commit (see
// https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request),
// so preview-build-pr names its artifact after a SHA this service never
// asks about - only the run's own head_sha metadata (populated by GitHub
// independently of what the job saw as $GITHUB_SHA) still says which
// commit it actually is. Can't filter this scan server-side by name (no
// exact name to filter by), so it has to page through results instead of
// trusting a single page holds the match.
export async function findPreviewArtifactByCommitSha(
  githubToken: string,
  sha: string
): Promise<GithubLookupResult<PreviewArtifact>> {
  const shaLower = sha.toLowerCase();
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/artifacts`;
  try {
    const exact = await listArtifacts(
      githubToken,
      artifactNameForSha(shaLower)
    );
    let match = matchArtifact(exact, shaLower);

    if (!match) {
      match = await findInFallbackPages(githubToken, shaLower);
    }

    if (!match) {
      return { status: "not_found" };
    }

    return { status: "found", data: toPreviewArtifact(match) };
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
