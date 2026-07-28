import { eq } from "drizzle-orm";
import { DatabaseResult } from "../../../lib/interfaces";
import { ExtensionsDb } from "../../../lib/db";
import { users } from "./db/external-tables";
import { databaseError } from "./errors";

export type GithubIdentity = {
  githubLogin: string | null;
  githubOrgs: string[];
};

// `users` is owned by the FOSSBilling/extensions repo (src/lib/db/users.sql there),
// NOT this repo, but lives in the same DB_EXTENSIONS database. If that schema
// changes (columns renamed/dropped), update fossbilling/api AND that file. Assumed
// columns used here: users.id (TEXT, = auth `sub` claim), users.is_moderator
// (INTEGER 0/1), users.github_login (TEXT), users.github_orgs (TEXT, JSON array).
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
  // only populated once the claimant has signed in via GitHub since the
  // auth service started requesting the read:org scope; absent columns/rows
  // resolve to "no linked identity" rather than throwing.
  async getGithubIdentity(userId: string): Promise<DatabaseResult<GithubIdentity>> {
    try {
      const [row] = await this.db
        .select({
          githubLogin: users.githubLogin,
          githubOrgs: users.githubOrgs
        })
        .from(users)
        .where(eq(users.id, userId));

      let githubOrgs: string[] = [];
      if (row?.githubOrgs) {
        try {
          const parsed = JSON.parse(row.githubOrgs);
          if (Array.isArray(parsed)) githubOrgs = parsed;
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
