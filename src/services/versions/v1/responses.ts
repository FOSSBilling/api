import { GitHubError } from "../../../lib/github-errors";
import { Releases } from "./interfaces";

// The response envelope and release-blob helpers shared by versions/v1 and
// stats/v1, which serve the same cached blob through the same shape. Kept
// beside getReleases so the cross-service contract stays in one place.

export type ReleaseSource = "cache" | "fresh" | "stale";

export function hasNoReleases(releases: Releases): boolean {
  return Object.keys(releases).length === 0;
}

// The details block GitHub errors carry into response envelopes.
export function githubErrorDetails(error: GitHubError) {
  return { http_status: error.httpStatus, error_code: error.errorCode };
}

export function buildUnavailableResponse(error: GitHubError) {
  return {
    result: null,
    error_code: 503,
    message: "Unable to fetch releases and no cached data available",
    details: githubErrorDetails(error)
  };
}

export function buildSuccessResponse<T>(
  result: T,
  source: ReleaseSource
): {
  result: T;
  error_code: 0;
  message: null;
  stale: boolean;
} {
  return {
    result,
    error_code: 0,
    message: null,
    stale: source === "stale"
  };
}
