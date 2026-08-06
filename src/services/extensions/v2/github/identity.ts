import { DatabaseError } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import {
  checkGithubEntity,
  GithubUnavailableReason,
  matchesClaimant,
  urlMatchesGithubBlog
} from "./verification";
import { Developer } from "../schemas/developers";
import { UsersDatabase } from "../db/users";

export type GithubOwnershipVerificationResult =
  | { mismatch: true }
  | {
      mismatch: false;
      githubOrgVerified: number | null;
      githubUrlVerified: number | null;
      note: string | null;
    }
  | { error: DatabaseError };

export function githubUnavailableError(
  reason: GithubUnavailableReason
): DatabaseError {
  if (reason === "unsupported_entity_type") {
    return {
      code: "GITHUB_ENTITY_UNSUPPORTED",
      message: "This GitHub account type is not supported"
    };
  }
  return reason === "rate_limited"
    ? {
        code: "RATE_LIMITED",
        message: "GitHub verification is temporarily rate limited"
      }
    : {
        code: "SERVICE_UNAVAILABLE",
        message: "GitHub verification is temporarily unavailable"
      };
}

// `githubToken` authenticates the GitHub entity-existence lookup only (a
// service-level credential, raises the public rate limit) — it is never
// the claimant's own token, which never leaves the auth service. Shared by
// claim() and upsertOwn(): both need the same question answered — does a
// real GitHub org/user exist for this id, and if so, does the caller's own
// linked GitHub identity match it? A positive mismatch is the only automated
// block; no real GitHub entity for this id, or the caller having no linked
// GitHub identity yet, both fall back to an explicitly unverified result for
// manual moderator review. That fallback never grants verified ownership.
// publisherUrl — only ever passed by upsertOwn's create path, which is the
// one place a new Publisher URL is actually being submitted alongside
// identity verification; claim() has no URL of its own to cross-check
// (the developer row it's claiming already exists). Drives
// githubUrlVerified only — a non-matching or unset GitHub "website" field
// never blocks or un-verifies identity, since it's optional and often
// stale, unlike the identity check above.
export async function verifyGithubOwnership(
  db: ExtensionsDb,
  developerId: string,
  developerType: Developer["type"],
  callerId: string,
  githubToken?: string,
  publisherUrl?: string
): Promise<GithubOwnershipVerificationResult> {
  const githubEntity = await checkGithubEntity(developerId, githubToken ?? "");

  if (githubEntity.status === "unavailable") {
    return { error: githubUnavailableError(githubEntity.reason) };
  }

  if (githubEntity.status === "not_found") {
    return {
      mismatch: false,
      githubOrgVerified: null,
      githubUrlVerified: null,
      note: "GitHub entity was not verified automatically — reviewed manually."
    };
  }

  // A real GitHub entity exists for this id, just under the other type
  // (e.g. a real org submitted as a "user") — this is a confirmed
  // disagreement with GitHub, not an unknown, so it must block rather than
  // fall back to unverified. Otherwise a caller could take a real org/user's
  // id unverified simply by submitting the wrong type for it.
  if (githubEntity.entity.type !== developerType) {
    return { mismatch: true };
  }

  const identity = await new UsersDatabase(db).getGithubIdentity(callerId);
  // A real DB/schema failure here is not the same as "caller has no linked
  // GitHub identity" — swallowing it would silently let creation/claiming
  // proceed unverified during an outage instead of surfacing the error.
  if (identity.error || !identity.data) {
    return {
      error: identity.error ?? {
        message: "Failed to load caller's GitHub identity",
        code: "DATABASE_ERROR"
      }
    };
  }
  const callerIdentity = identity.data;

  // Organization membership is only a definitive non-match when central auth
  // supplied a valid, unexpired membership snapshot. Missing, malformed, or
  // expired evidence is inconclusive and must go to manual review instead of
  // blocking an otherwise valid claimant/profile owner. This path never
  // grants verified ownership; the profile/claim still needs moderation.
  if (
    !callerIdentity.githubLogin?.trim() ||
    (developerType === "organization" && !callerIdentity.githubOrgsAvailable)
  ) {
    return {
      mismatch: false,
      githubOrgVerified: null,
      githubUrlVerified: null,
      note: !callerIdentity.githubLogin?.trim()
        ? "Caller has no linked GitHub identity yet — reviewed manually."
        : "Caller's GitHub organization memberships could not be confirmed — reviewed manually."
    };
  }

  if (matchesClaimant(developerType, developerId, callerIdentity)) {
    return {
      mismatch: false,
      githubOrgVerified: 1,
      githubUrlVerified: urlMatchesGithubBlog(
        publisherUrl,
        githubEntity.entity.blog
      )
        ? 1
        : null,
      note: "Verified: caller's linked GitHub identity matches."
    };
  }

  return { mismatch: true };
}
