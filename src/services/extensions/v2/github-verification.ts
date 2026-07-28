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

// Returns the GitHub account "type" for `id` (translated to this app's
// user/organization vocabulary), or null if no such account exists — or if
// the lookup itself failed (auth error, rate limit, network issue,
// unexpected response shape). A failed lookup is indistinguishable from "no
// such account" here on purpose: both mean claim() can't verify anything and
// must fall back to manual moderator review, never block.
export async function checkGithubEntityType(
  id: string,
  githubToken: string
): Promise<Developer["type"] | null> {
  try {
    const result = await ghRequest("GET /users/{username}", {
      username: id,
      headers: githubToken ? { authorization: `Bearer ${githubToken}` } : {}
    });
    if (result.data.type === "Organization") return "organization";
    if (result.data.type === "User") return "user";
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
