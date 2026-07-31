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

// Returns the GitHub account "type" for `id` (translated to this app's
// user/organization vocabulary) plus its on-file website, or null if no such
// account exists — or if the lookup itself failed (auth error, rate limit,
// network issue, unexpected response shape). A failed lookup is
// indistinguishable from "no such account" here on purpose: both mean
// claim() can't verify anything and must fall back to manual moderator
// review, never block.
export async function checkGithubEntity(
  id: string,
  githubToken: string
): Promise<GithubEntity | null> {
  try {
    const result = await ghRequest("GET /users/{username}", {
      username: id,
      headers: githubToken ? { authorization: `Bearer ${githubToken}` } : {}
    });
    const blog = result.data.blog?.trim() || null;
    if (result.data.type === "Organization") {
      return { type: "organization", blog };
    }
    if (result.data.type === "User") {
      return { type: "user", blog };
    }
    return null;
  } catch (error) {
    const githubError = classifyGitHubError(
      error,
      `https://api.github.com/users/${id}`
    );
    if (!(githubError instanceof NotFoundError)) {
      logWarn(
        "extensions-v2",
        "GitHub entity lookup failed, falling back to manual claim review",
        { id, message: githubError.message }
      );
    }
    return null;
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
