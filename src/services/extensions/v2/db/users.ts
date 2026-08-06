import { and, eq, isNull } from "drizzle-orm";
import { DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { users } from "./schema";
import { databaseError } from "./errors";
import { toD1Statement } from "./batch";

export type GithubIdentity = {
  githubLogin: string | null;
  githubOrgs: string[];
  // Distinguishes a freshly synchronized empty membership list (a confirmed
  // non-member) from absent, malformed, or expired evidence. The latter must
  // fall back to moderator review rather than being treated as a mismatch.
  githubOrgsAvailable: boolean;
  // Raw values used to make a re-verification write conditional on the same
  // identity snapshot that was read. The parsed fields above are sufficient
  // for matching, but cannot distinguish a concurrent sync from an unchanged
  // empty/missing membership list on their own.
  githubOrgsSnapshot: string | null;
  githubOrgsExpiresAt: string | null;
};

export type UserIdentityInput = {
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  picture: string | null;
  githubLogin: string | null;
  githubOrgs: string[] | null;
  githubOrgsExpiresAt: string | null;
};

export type UserRecord = {
  id: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  picture: string | null;
  displayName: string | null;
  isModerator: boolean;
  githubLinked: boolean;
  deletedAt: string | null;
};

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isFutureGithubOrgsExpiry(
  value: string | null | undefined,
  now = Date.now()
): boolean {
  if (!value) return false;

  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return false;

  // Date.parse normalizes out-of-range fields instead of rejecting them
  // (2025-02-30 becomes 2025-03-02, 24:00 rolls to the next day), so a
  // malformed central-auth timestamp would otherwise be accepted as usable,
  // future membership evidence. Round-tripping through Date.UTC and checking
  // every field survived is equivalent to validating them by hand, and gets
  // month lengths and leap years from the platform rather than a table here.
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const roundTrip = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second)
  );
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute ||
    roundTrip.getUTCSeconds() !== second
  ) {
    return false;
  }

  // The offset is applied by Date.parse below rather than by the round trip,
  // so its range is still checked directly.
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (offsetHour > 23 || offsetMinute > 59) return false;

  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function hasUsableGithubOrgs(
  value: string | null,
  expiresAt: string | null
): boolean {
  if (value === null || !isFutureGithubOrgsExpiry(expiresAt)) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      Array.isArray(parsed) && parsed.every((org) => typeof org === "string")
    );
  } catch {
    return false;
  }
}

export class UsersDatabase {
  constructor(private db: ExtensionsDb) {}

  async syncIdentity(
    userId: string,
    input: UserIdentityInput
  ): Promise<DatabaseResult<UserRecord>> {
    const now = new Date().toISOString();
    const hasFreshGithubOrgs =
      Array.isArray(input.githubOrgs) &&
      isFutureGithubOrgsExpiry(input.githubOrgsExpiresAt);

    const projection = {
      name: input.name,
      email: input.email,
      emailVerified: input.emailVerified ? 1 : 0,
      picture: input.picture,
      updatedAt: now,
      githubLogin: input.githubLogin,
      githubOrgs: hasFreshGithubOrgs ? JSON.stringify(input.githubOrgs) : null,
      githubOrgsExpiresAt: hasFreshGithubOrgs
        ? input.githubOrgsExpiresAt
        : null,
      deletedAt: null
    };

    try {
      await this.db
        .insert(users)
        .values({ ...projection, id: userId, createdAt: now })
        // Insert and update must write the same projection - a field added to
        // one and not the other would apply to new accounts but silently skip
        // returning ones, or the reverse. created_at is the only difference,
        // and it is deliberately not re-stamped on conflict.
        .onConflictDoUpdate({ target: users.id, set: projection })
        .run();

      return this.get(userId);
    } catch (error) {
      return databaseError("syncIdentity", error);
    }
  }

  async get(userId: string): Promise<DatabaseResult<UserRecord>> {
    try {
      const [row] = await this.db
        .select()
        .from(users)
        .where(eq(users.id, userId));
      if (!row) {
        return {
          data: null,
          error: { message: "User not found", code: "NOT_FOUND" }
        };
      }

      const active = row.deletedAt === null;
      return {
        data: {
          id: row.id,
          name: row.name,
          email: row.email,
          emailVerified: row.emailVerified === 1,
          picture: row.picture,
          displayName: row.displayName,
          isModerator: active && row.isModerator === 1,
          githubLinked:
            active &&
            Boolean(row.githubLogin) &&
            hasUsableGithubOrgs(row.githubOrgs, row.githubOrgsExpiresAt),
          deletedAt: row.deletedAt
        },
        error: null
      };
    } catch (error) {
      return databaseError("get", error);
    }
  }

  async isActive(userId: string): Promise<DatabaseResult<boolean>> {
    try {
      const [row] = await this.db
        .select({ deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, userId));
      return { data: row !== undefined && row.deletedAt === null, error: null };
    } catch (error) {
      return databaseError("isActive", error);
    }
  }

  async updateDisplayName(
    userId: string,
    displayName: string | null
  ): Promise<DatabaseResult<{ displayName: string | null }>> {
    try {
      const result = await this.db
        .update(users)
        .set({ displayName, updatedAt: new Date().toISOString() })
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .run();
      if (!result.meta?.changes) {
        return {
          data: null,
          error: { message: "User not found", code: "NOT_FOUND" }
        };
      }
      return { data: { displayName }, error: null };
    } catch (error) {
      return databaseError("updateDisplayName", error);
    }
  }

  async deleteAccount(
    userId: string
  ): Promise<DatabaseResult<{ deleted: true }>> {
    const deletedAt = new Date().toISOString();
    try {
      const [user] = await this.db
        .select({ deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, userId));
      if (!user || user.deletedAt !== null) {
        return {
          data: null,
          error: { message: "User not found", code: "NOT_FOUND" }
        };
      }

      // The first statement is a guarded reservation. All later statements
      // require this exact marker, so a blocked or raced deletion cannot
      // touch any domain rows. D1 batches are transactional: SQL failures
      // roll the whole reservation and cleanup back together.
      const reserveStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE users
              SET deleted_at = ?, updated_at = ?
              WHERE id = ? AND deleted_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM developers d
                  WHERE d.owner_user_id = ?
                    AND EXISTS (SELECT 1 FROM extensions e WHERE e.author_id = d.id)
                )
                AND NOT EXISTS (
                  SELECT 1 FROM developers d
                  JOIN extension_submissions s ON s.developer_id = d.id
                  WHERE d.owner_user_id = ? AND s.status = 'pending'
                )`,
        params: [deletedAt, deletedAt, userId, userId, userId]
      });

      const rejectSubmissionsStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE extension_submissions
              SET status = 'rejected',
                  review_note = 'Submitter account deleted',
                  reviewed_at = CURRENT_TIMESTAMP
              WHERE submitted_by = ? AND status = 'pending'
                AND EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at = ?)`,
        params: [userId, userId, deletedAt]
      });

      const rejectClaimsStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developer_claims
              SET status = 'rejected',
                  review_note = 'Claimant account deleted',
                  reviewed_at = CURRENT_TIMESTAMP
              WHERE claimant_id = ? AND status = 'pending'
                AND EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at = ?)`,
        params: [userId, userId, deletedAt]
      });

      const deleteTransfersStmt = toD1Statement(this.db.$client, {
        sql: `DELETE FROM developer_transfers
              WHERE developer_id IN (
                SELECT id FROM developers WHERE owner_user_id = ?
              )
                AND EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at = ?)`,
        params: [userId, userId, deletedAt]
      });

      const deleteClaimsStmt = toD1Statement(this.db.$client, {
        sql: `DELETE FROM developer_claims
              WHERE developer_id IN (
                SELECT id FROM developers WHERE owner_user_id = ?
              )
                AND EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at = ?)`,
        params: [userId, userId, deletedAt]
      });

      const deleteDeveloperStmt = toD1Statement(this.db.$client, {
        sql: `DELETE FROM developers
              WHERE owner_user_id = ?
                AND NOT EXISTS (SELECT 1 FROM extensions WHERE author_id = developers.id)
                AND NOT EXISTS (
                  SELECT 1 FROM extension_submissions
                  WHERE developer_id = developers.id AND status = 'pending'
                )
                AND EXISTS (SELECT 1 FROM users WHERE id = ? AND deleted_at = ?)`,
        params: [userId, userId, deletedAt]
      });

      const clearUserStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE users
              SET name = NULL,
                  email = NULL,
                  email_verified = 0,
                  picture = NULL,
                  display_name = NULL,
                  is_moderator = 0,
                  github_login = NULL,
                  github_orgs = NULL,
                  github_orgs_expires_at = NULL,
                  updated_at = ?
              WHERE id = ? AND deleted_at = ?`,
        params: [deletedAt, userId, deletedAt]
      });

      const results = await this.db.$client.batch([
        reserveStmt,
        rejectSubmissionsStmt,
        rejectClaimsStmt,
        deleteTransfersStmt,
        deleteClaimsStmt,
        deleteDeveloperStmt,
        clearUserStmt
      ]);

      if (!results[0]?.meta?.changes || !results[6]?.meta?.changes) {
        return {
          data: null,
          error: {
            message:
              "The account cannot be deleted while it owns published extensions or pending submissions",
            code: "CONFLICT"
          }
        };
      }

      return { data: { deleted: true }, error: null };
    } catch (error) {
      return databaseError("deleteAccount", error);
    }
  }

  // Moderator routes need to tell "account deactivated" (ACCOUNT_INACTIVE)
  // apart from "not a moderator" (FORBIDDEN), and both answers live in the
  // same row - so they read it once here rather than stacking an isActive()
  // check in front of a separate moderator lookup.
  async moderatorAccess(
    userId: string
  ): Promise<DatabaseResult<{ active: boolean; moderator: boolean }>> {
    try {
      const [row] = await this.db
        .select({
          isModerator: users.isModerator,
          deletedAt: users.deletedAt
        })
        .from(users)
        .where(eq(users.id, userId));
      const active = row !== undefined && row.deletedAt === null;
      return {
        data: { active, moderator: active && row.isModerator === 1 },
        error: null
      };
    } catch (error) {
      return databaseError("moderatorAccess", error);
    }
  }

  // Used to verify developer-profile claims against the claimant's own
  // linked GitHub identity — see DeveloperClaimsDatabase.claim(). github_orgs is
  // only usable while its central-auth expiry is in the future; absent,
  // malformed, or expired organization evidence resolves to no memberships
  // rather than throwing. githubOrgsAvailable preserves whether that empty
  // result is a confirmed snapshot or merely unavailable evidence.
  async getGithubIdentity(
    userId: string
  ): Promise<DatabaseResult<GithubIdentity>> {
    try {
      const [row] = await this.db
        .select({
          githubLogin: users.githubLogin,
          githubOrgs: users.githubOrgs,
          githubOrgsExpiresAt: users.githubOrgsExpiresAt,
          deletedAt: users.deletedAt
        })
        .from(users)
        .where(eq(users.id, userId));

      if (row?.deletedAt !== null && row?.deletedAt !== undefined) {
        return {
          data: {
            githubLogin: null,
            githubOrgs: [],
            githubOrgsAvailable: false,
            githubOrgsSnapshot: null,
            githubOrgsExpiresAt: null
          },
          error: null
        };
      }

      let githubOrgs: string[] = [];
      let githubOrgsAvailable = false;
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
            githubOrgsAvailable = true;
          }
        } catch {
          // Malformed JSON is treated the same as "no orgs recorded" —
          // never let a parse failure block or wrongly verify a claim.
        }
      }

      return {
        data: {
          githubLogin: row?.githubLogin ?? null,
          githubOrgs,
          githubOrgsAvailable,
          githubOrgsSnapshot: row?.githubOrgs ?? null,
          githubOrgsExpiresAt: row?.githubOrgsExpiresAt ?? null
        },
        error: null
      };
    } catch (error) {
      return databaseError("getGithubIdentity", error);
    }
  }
}
