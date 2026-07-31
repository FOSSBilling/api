import { eq } from "drizzle-orm";
import { DatabaseResult } from "../../../lib/interfaces";
import { ExtensionsDb } from "../../../lib/db";
import { users } from "./db/external-tables";
import { databaseError } from "./errors";

export type GithubIdentity = {
  githubLogin: string | null;
  githubOrgs: string[];
};

function isFutureGithubOrgsExpiry(
  value: string | null | undefined,
  now = Date.now()
): boolean {
  if (!value) return false;
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

// `users` is owned by the FOSSBilling/extensions repo (src/lib/db/users.sql there),
// NOT this repo, but lives in the same DB_EXTENSIONS database. If that schema
// changes (columns renamed/dropped), update fossbilling/api AND that file. Assumed
// columns used here: users.id (TEXT, = auth `sub` claim), users.is_moderator
// (INTEGER 0/1), users.github_login (TEXT), users.github_orgs (TEXT, JSON
// array), and users.github_orgs_expires_at (TEXT, absolute RFC3339 expiry).
export class UsersDatabase {
  constructor(private db: ExtensionsDb) {}

  async isModerator(userId: string): Promise<DatabaseResult<boolean>> {
    try {
      const [row] = await this.db
        .select({ isModerator: users.isModerator })
        .from(users)
        .where(eq(users.id, userId));
      return { data: row?.isModerator === 1, error: null };
    } catch (error) {
      return databaseError("isModerator", error);
    }
  }

  // Used to verify developer-profile claims against the claimant's own
  // linked GitHub identity — see DevelopersDatabase.claim(). github_orgs is
  // only usable while its central-auth expiry is in the future; absent,
  // malformed, or expired organization evidence resolves to no memberships
  // rather than throwing.
  async getGithubIdentity(
    userId: string
  ): Promise<DatabaseResult<GithubIdentity>> {
    try {
      const [row] = await this.db
        .select({
          githubLogin: users.githubLogin,
          githubOrgs: users.githubOrgs,
          githubOrgsExpiresAt: users.githubOrgsExpiresAt
        })
        .from(users)
        .where(eq(users.id, userId));

      let githubOrgs: string[] = [];
      if (
        row?.githubOrgs &&
        isFutureGithubOrgsExpiry(row.githubOrgsExpiresAt)
      ) {
        try {
          const parsed = JSON.parse(row.githubOrgs);
          if (
            Array.isArray(parsed) &&
            parsed.every((org) => typeof org === "string")
          ) {
            githubOrgs = parsed;
          }
        } catch {
          // Malformed JSON is treated the same as "no orgs recorded" —
          // never let a parse failure block or wrongly verify a claim.
        }
      }

      return {
        data: { githubLogin: row?.githubLogin ?? null, githubOrgs },
        error: null
      };
    } catch (error) {
      return databaseError("getGithubIdentity", error);
    }
  }
}
