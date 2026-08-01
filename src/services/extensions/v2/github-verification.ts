import { request as ghRequest } from "@octokit/request";
import { classifyGitHubError, NotFoundError } from "../../../lib/github-errors";
import { logWarn } from "../../../lib/logger";
import { Developer } from "./interfaces";
import { GithubIdentity } from "./users-database";

// Used by DevelopersDatabase.claim() to gate self-service claims on an
// unowned developer id: does a real GitHub org/user exist for this id, and
// does the claimant's own linked GitHub identity match it? See the comment
// on DevelopersDatabase.claim() for the full decision matrix — this module
// only answers the two underlying questions, it never decides to block.

export type GithubEntity = {
  type: Developer["type"];
  // GitHub's own "website" field for this user/org (the same one shown on
  // their profile page), or null if unset. Same endpoint as the type check
  // below, so reading it costs nothing extra.
  blog: string | null;
};

export type GithubUnavailableReason =
  | "rate_limited"
  | "authentication"
  | "network"
  | "upstream"
  | "invalid_response";

export type GithubEntityResult =
  | { status: "found"; entity: GithubEntity }
  | { status: "not_found" }
  | {
      status: "unavailable";
      reason: GithubUnavailableReason;
    };

function unavailable(
  id: string,
  reason: GithubUnavailableReason,
  httpStatus?: number
): GithubEntityResult {
  logWarn("extensions-v2", "GitHub entity lookup unavailable", {
    id,
    reason,
    ...(httpStatus === undefined ? {} : { status: httpStatus })
  });
  return { status: "unavailable", reason };
}

// Returns the GitHub account "type" for `id` (translated to this app's
// user/organization vocabulary) plus its on-file website. A confirmed 404 is
// kept distinct from authentication, throttling, network/upstream failures,
// and invalid data so callers never mistake an outage for a missing account.
export async function checkGithubEntity(
  id: string,
  githubToken: string
): Promise<GithubEntityResult> {
  try {
    const result = await ghRequest("GET /users/{username}", {
      username: id,
      headers: githubToken ? { authorization: `Bearer ${githubToken}` } : {}
    });
    if (
      typeof result.data !== "object" ||
      result.data === null ||
      !("type" in result.data) ||
      ("blog" in result.data &&
        result.data.blog !== null &&
        result.data.blog !== undefined &&
        typeof result.data.blog !== "string")
    ) {
      return unavailable(id, "invalid_response");
    }
    const blog =
      "blog" in result.data && typeof result.data.blog === "string"
        ? result.data.blog.trim() || null
        : null;
    if (result.data.type === "Organization") {
      return { status: "found", entity: { type: "organization", blog } };
    }
    if (result.data.type === "User") {
      return { status: "found", entity: { type: "user", blog } };
    }
    return unavailable(id, "invalid_response");
  } catch (error) {
    const githubError = classifyGitHubError(
      error,
      `https://api.github.com/users/${id}`
    );
    if (githubError instanceof NotFoundError) return { status: "not_found" };

    const rawError =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)
        : undefined;
    const status =
      typeof rawError?.status === "number"
        ? rawError.status
        : githubError.httpStatus;
    const response = rawError?.response as
      { headers?: Record<string, string> } | undefined;
    const isRateLimited =
      status === 429 ||
      (status === 403 &&
        ((typeof rawError?.message === "string" &&
          rawError.message.toLowerCase().includes("rate limit")) ||
          response?.headers?.["x-ratelimit-remaining"] === "0"));

    if (isRateLimited) return unavailable(id, "rate_limited", status);
    if (status === 401 || status === 403) {
      return unavailable(id, "authentication", status);
    }
    if (githubError.errorCode === "validation_error") {
      return unavailable(id, "invalid_response", status);
    }
    if (githubError.errorCode === "network_error" || status === undefined) {
      return unavailable(id, "network");
    }
    return unavailable(id, "upstream", status);
  }
}

// Loose match on host + path, ignoring scheme/www/trailing slash — GitHub's
// own `blog` field is freeform text (often missing a scheme, e.g.
// "example.com"), so an exact string compare would miss real matches. Host
// is compared case-insensitively (including port, since a non-default port
// is a different site) and path case-sensitively, per URL semantics.
export function urlMatchesGithubBlog(
  publisherUrl: string | undefined,
  blog: string | null
): boolean {
  if (!publisherUrl || !blog) return false;
  const normalize = (value: string) => {
    try {
      const url = new URL(
        /^https?:\/\//i.test(value) ? value : `https://${value}`
      );
      const host = url.host.replace(/^www\./i, "").toLowerCase();
      return `${host}${url.pathname}`.replace(/\/$/, "");
    } catch {
      return null;
    }
  };
  const a = normalize(publisherUrl);
  const b = normalize(blog);
  return a !== null && a === b;
}

// developerId/claimant.githubOrgs are already lowercase (developerId() and
// the auth service's org-membership sync both normalize to lowercase).
export function matchesClaimant(
  developerType: Developer["type"],
  developerId: string,
  claimant: GithubIdentity
): boolean {
  if (developerType === "user") {
    return claimant.githubLogin?.toLowerCase() === developerId;
  }
  return claimant.githubOrgs.includes(developerId);
}
