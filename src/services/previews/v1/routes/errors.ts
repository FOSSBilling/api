import { GitHubError, RateLimitError } from "../../../../lib/github-errors";

// A GitHub outage/rate-limit is a 503 (retry later); anything else
// unexpected from classifyGitHubError is a 500.
export function statusFromGithubError(error: GitHubError): 429 | 503 | 500 {
  if (error instanceof RateLimitError) return 429;
  if (error.httpStatus !== undefined && error.httpStatus >= 500) return 503;
  return 500;
}

export function githubErrorBody(error: GitHubError, fallbackMessage: string) {
  return {
    error: {
      message: error.message || fallbackMessage,
      code: error.errorCode ?? "GITHUB_ERROR"
    }
  };
}

export function notFoundBody(message: string) {
  return { error: { message, code: "NOT_FOUND" } };
}
