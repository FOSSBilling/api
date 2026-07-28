import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
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
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  async isModerator(userId: string): Promise<DatabaseResult<boolean>> {
    try {
      const row = await this.db
        .prepare("SELECT is_moderator FROM users WHERE id = ?")
        .bind(userId)
        .first<{ is_moderator: number }>();
      return { data: row?.is_moderator === 1, error: null };
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
      const row = await this.db
        .prepare("SELECT github_login, github_orgs FROM users WHERE id = ?")
        .bind(userId)
        .first<{ github_login: string | null; github_orgs: string | null }>();

      let githubOrgs: string[] = [];
      if (row?.github_orgs) {
        try {
          const parsed = JSON.parse(row.github_orgs);
          if (Array.isArray(parsed)) githubOrgs = parsed;
        } catch {
          // Malformed JSON is treated the same as "no orgs recorded" —
          // never let a parse failure block or wrongly verify a claim.
        }
      }

      return {
        data: { githubLogin: row?.github_login ?? null, githubOrgs },
        error: null
      };
    } catch (error) {
      return databaseError("getGithubIdentity", error);
    }
  }
}
