import {
  DatabaseError,
  DatabaseResult,
  IDatabase
} from "../../../lib/interfaces";
import { databaseError } from "./errors";
import { checkGithubEntityType, matchesClaimant } from "./github-verification";
import {
  Developer,
  DeveloperClaim,
  DeveloperHistoryEntry,
  DeveloperProfile,
  DeveloperTransfer,
  PendingDeveloperClaim
} from "./interfaces";
import { UsersDatabase } from "./users-database";

// Matches the SQLite/D1 message for the idx_developers_owner_unique
// violation, which is how a lost race between two concurrent first-time PUT
// /developers/me requests (same caller, different ids) surfaces.
function isOwnerConflict(message: string | undefined): boolean {
  return !!message && /UNIQUE constraint failed.*owner_user_id/i.test(message);
}

// Matches the SQLite/D1 message for the idx_developer_claims_pending_unique
// violation, which is how a duplicate claim() call while one is already
// pending surfaces.
function isPendingClaimConflict(message: string | undefined): boolean {
  return (
    !!message && /UNIQUE constraint failed.*developer_claims/i.test(message)
  );
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// SQLite's CURRENT_TIMESTAMP renders as "YYYY-MM-DD HH:MM:SS" (space
// separator, no milliseconds, no "Z"). expires_at is compared against it
// directly in SQL (`expires_at > CURRENT_TIMESTAMP`), which is a plain
// string comparison — a JS `Date#toISOString()` value ("...THH:MM:SS.sssZ")
// would sort wrong once the two share the same calendar day, since 'T'
// (0x54) always outranks ' ' (0x20) at that position regardless of the
// actual time that follows. Matching the format keeps the comparison correct.
function toSqliteDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function parseDeveloperRow(row: Record<string, unknown>): DeveloperProfile {
  return {
    id: row.id as string,
    type: row.type as DeveloperProfile["type"],
    name: row.name as string,
    URL: (row.url as string | null) ?? undefined,
    avatar_url: (row.avatar_url as string | null) ?? undefined,
    contact_email: (row.contact_email as string | null) ?? undefined,
    approved:
      row.approved_at !== null &&
      row.approved_at !== undefined &&
      (row.approved_revision == null ||
        Number(row.approved_revision) === Number(row.content_revision ?? 1)),
    content_revision: Number(row.content_revision ?? 1),
    github_org_verified:
      row.github_org_verified === null || row.github_org_verified === undefined
        ? undefined
        : row.github_org_verified === 1,
    github_verification_note:
      (row.github_verification_note as string | null) ?? undefined
  };
}

function parseClaimRow(row: Record<string, unknown>): DeveloperClaim {
  return {
    id: row.id as string,
    developer_id: row.developer_id as string,
    claimant_id: row.claimant_id as string,
    status: row.status as DeveloperClaim["status"],
    note: (row.note as string | null) ?? undefined,
    review_note: (row.review_note as string | null) ?? undefined,
    reviewer_id: (row.reviewer_id as string | null) ?? undefined,
    created_at: row.created_at as string,
    reviewed_at: (row.reviewed_at as string | null) ?? undefined,
    github_org_verified:
      row.github_org_verified === null || row.github_org_verified === undefined
        ? undefined
        : row.github_org_verified === 1,
    github_verification_note:
      (row.github_verification_note as string | null) ?? undefined
  };
}

export class DevelopersDatabase {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  // githubToken — see the comment on verifyGithubOwnership(). Only consulted
  // when creating a brand-new profile (developer.id is immutable once
  // owned, so an update can't need re-verifying); guards against squatting
  // on an id that matches a real GitHub org/user the caller doesn't control,
  // the one gap claim() alone can't close since it only ever applies to
  // rows that already exist unowned.
  async upsertOwn(
    userId: string,
    developer: Developer,
    githubToken?: string
  ): Promise<DatabaseResult<DeveloperProfile>> {
    try {
      const existingOwn = await this.db
        .prepare("SELECT * FROM developers WHERE owner_user_id = ?")
        .bind(userId)
        .first<Record<string, unknown>>();

      const existingById = await this.db
        .prepare("SELECT * FROM developers WHERE id = ?")
        .bind(developer.id)
        .first<Record<string, unknown>>();

      let githubOrgVerified: number | null = null;
      let githubVerificationNote: string | null = null;

      let mainStmt;
      if (!existingOwn) {
        if (existingById) {
          // Distinct from the generic CONFLICT used elsewhere in this file —
          // consumers (the extensions repo's create-profile form) need to
          // reliably detect this specific case to point the user at the
          // claim flow, which a shared, message-string-matched code can't do.
          return {
            data: null,
            error: {
              message: "Developer id already exists",
              code: "DEVELOPER_ID_TAKEN"
            }
          };
        }

        const check = await this.verifyGithubOwnership(
          developer.id,
          developer.type,
          userId,
          githubToken
        );

        if ("error" in check) {
          return { data: null, error: check.error };
        }

        if (check.mismatch) {
          return {
            data: null,
            error: {
              code: "GITHUB_MISMATCH",
              message:
                "This id matches a real GitHub organization or username that isn't linked to your account, so it can't be used automatically. Make sure you're signed in with the right GitHub account, or choose a different id."
            }
          };
        }

        githubOrgVerified = check.githubOrgVerified;
        githubVerificationNote = check.note;

        mainStmt = this.db
          .prepare(
            `INSERT INTO developers (id, type, name, url, avatar_url, contact_email, owner_user_id, approved_at, github_org_verified, github_verification_note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
          )
          .bind(
            developer.id,
            developer.type,
            developer.name,
            developer.URL ?? null,
            developer.avatar_url ?? null,
            developer.contact_email ?? null,
            userId,
            githubOrgVerified,
            githubVerificationNote
          );
      } else {
        if (developer.id !== existingOwn.id) {
          return {
            data: null,
            error: {
              message: "Developer id cannot be changed",
              code: "CONFLICT"
            }
          };
        }

        // approved_at is always cleared here, even if nothing meaningful
        // changed — the reviewed content just got overwritten, so the old
        // approval no longer applies. Not worth diffing old vs. new values.
        mainStmt = this.db
          .prepare(
            `UPDATE developers
             SET type = ?, name = ?, url = ?, avatar_url = ?, contact_email = ?,
                 content_revision = content_revision + 1,
                 approved_at = NULL, approved_revision = NULL, approved_by = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND owner_user_id = ?`
          )
          .bind(
            developer.type,
            developer.name,
            developer.URL ?? null,
            developer.avatar_url ?? null,
            developer.contact_email ?? null,
            developer.id,
            userId
          );
      }

      if (!this.db.batch) {
        return databaseError(
          "upsertOwn",
          new Error("Database adapter does not support batch operations")
        );
      }

      const historyStmt = this.db
        .prepare(
          `INSERT INTO developer_history (id, developer_id, type, name, url, changed_by, changed_at)
           SELECT ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
           WHERE changes() = 1`
        )
        .bind(
          crypto.randomUUID(),
          developer.id,
          developer.type,
          developer.name,
          developer.URL ?? null,
          userId
        );

      let results;
      try {
        results = (await this.db.batch([mainStmt, historyStmt])) as Array<{
          success: boolean;
          error?: string;
          meta?: { changes?: number };
        }>;
      } catch (error) {
        if (isOwnerConflict(error instanceof Error ? error.message : "")) {
          return {
            data: null,
            error: {
              message: "You already have a developer profile",
              code: "CONFLICT"
            }
          };
        }
        return databaseError("upsertOwn", error);
      }

      const failed = results.find((r) => !r.success);
      if (failed) {
        if (isOwnerConflict(failed.error)) {
          return {
            data: null,
            error: {
              message: "You already have a developer profile",
              code: "CONFLICT"
            }
          };
        }
        return databaseError(
          "upsertOwn",
          new Error(failed.error || "Database write failed")
        );
      }

      if (!results[0]?.meta?.changes) {
        return {
          data: null,
          error: {
            message: "Developer ownership changed while updating the profile",
            code: "CONFLICT"
          }
        };
      }

      const current = await this.db
        .prepare("SELECT * FROM developers WHERE id = ? AND owner_user_id = ?")
        .bind(developer.id, userId)
        .first<Record<string, unknown>>();
      if (!current) {
        return {
          data: null,
          error: {
            message: "Developer ownership changed while updating the profile",
            code: "CONFLICT"
          }
        };
      }
      return { data: parseDeveloperRow(current), error: null };
    } catch (error) {
      return databaseError("upsertOwn", error);
    }
  }

  // Diagnoses why the guarded delete in deleteOwn() below affected zero
  // rows: distinguishes no-longer-owned/nonexistent from the two blocking
  // conditions, without reopening the race the guard already closed.
  private async deletionBlockedError(
    developerId: string,
    userId: string
  ): Promise<{ code: "NOT_FOUND" | "CONFLICT"; message: string }> {
    const developer = await this.db
      .prepare("SELECT owner_user_id FROM developers WHERE id = ?")
      .bind(developerId)
      .first<{ owner_user_id: string | null }>();

    if (!developer || developer.owner_user_id !== userId) {
      return { code: "NOT_FOUND", message: "Developer not found" };
    }

    const extensionCount = await this.db
      .prepare("SELECT COUNT(*) AS count FROM extensions WHERE author_id = ?")
      .bind(developerId)
      .first<{ count: number }>();
    const extensionsCount = extensionCount?.count ?? 0;
    if (extensionsCount > 0) {
      return {
        code: "CONFLICT",
        message: `You have ${extensionsCount} published extension(s) under this profile. Transfer ownership or remove them before deleting it.`
      };
    }

    const pendingCount = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM extension_submissions WHERE developer_id = ? AND status = 'pending'"
      )
      .bind(developerId)
      .first<{ count: number }>();
    if ((pendingCount?.count ?? 0) > 0) {
      return {
        code: "CONFLICT",
        message:
          "You have a pending submission under review. Wait for it to be resolved before deleting your profile."
      };
    }

    // The guard failed but a fresh look finds nothing wrong — whatever
    // blocked it (someone else's transfer/claim landing, a submission
    // that has since been resolved) has already cleared. Ask the caller
    // to retry rather than guessing at a reason that's no longer true.
    return {
      code: "CONFLICT",
      message:
        "Your profile changed while processing this request. Please try again."
    };
  }

  // Permanently removes the caller's own developer profile, for a
  // privacy-focused account-deletion flow. Refuses while anything would be
  // left dangling in a way that isn't just historical record-keeping:
  // published extensions (someone still needs to own them) and pending
  // submissions (nothing left to approve/reject against once the named
  // developer is gone). developer_history is deliberately left alone —
  // it's an append-only audit log, moderator-only, never rendered publicly,
  // and 0009_drop_developer_history_fk.sql dropped its FK to developers(id)
  // specifically so a deleted developer's history rows can outlive it.
  async deleteOwn(
    userId: string
  ): Promise<DatabaseResult<{ id: string; deleted: true }>> {
    try {
      const developer = await this.db
        .prepare("SELECT id FROM developers WHERE owner_user_id = ?")
        .bind(userId)
        .first<{ id: string }>();

      if (!developer) {
        return {
          data: null,
          error: { message: "Developer not found", code: "NOT_FOUND" }
        };
      }

      if (!this.db.batch) {
        return databaseError(
          "deleteOwn",
          new Error("Database adapter does not support batch operations")
        );
      }

      // Every statement re-checks eligibility (still owned by this caller,
      // no published extensions, no pending submission) at the moment it
      // runs, rather than trusting the SELECT above: ownership can move
      // (an accepted transfer/claim) and a new extension or pending
      // submission can appear between that check and this write, and this
      // delete is the caller's only authorization check. The same guard is
      // repeated on all three statements — not just the last — so they're
      // all-or-nothing: if it fails, nothing here is touched, instead of
      // transfers/claims being deleted out from under a profile whose own
      // deletion then gets blocked.
      const deleteTransfersStmt = this.db
        .prepare(
          `DELETE FROM developer_transfers
           WHERE developer_id = ?
             AND EXISTS (
               SELECT 1 FROM developers
               WHERE developers.id = developer_transfers.developer_id
                 AND developers.owner_user_id = ?
                 AND NOT EXISTS (SELECT 1 FROM extensions WHERE extensions.author_id = developers.id)
                 AND NOT EXISTS (
                   SELECT 1 FROM extension_submissions
                   WHERE extension_submissions.developer_id = developers.id
                     AND extension_submissions.status = 'pending'
                 )
             )`
        )
        .bind(developer.id, userId);

      const deleteClaimsStmt = this.db
        .prepare(
          `DELETE FROM developer_claims
           WHERE developer_id = ?
             AND EXISTS (
               SELECT 1 FROM developers
               WHERE developers.id = developer_claims.developer_id
                 AND developers.owner_user_id = ?
                 AND NOT EXISTS (SELECT 1 FROM extensions WHERE extensions.author_id = developers.id)
                 AND NOT EXISTS (
                   SELECT 1 FROM extension_submissions
                   WHERE extension_submissions.developer_id = developers.id
                     AND extension_submissions.status = 'pending'
                 )
             )`
        )
        .bind(developer.id, userId);

      const deleteDeveloperStmt = this.db
        .prepare(
          `DELETE FROM developers
           WHERE id = ?
             AND owner_user_id = ?
             AND NOT EXISTS (SELECT 1 FROM extensions WHERE extensions.author_id = developers.id)
             AND NOT EXISTS (
               SELECT 1 FROM extension_submissions
               WHERE extension_submissions.developer_id = developers.id
                 AND extension_submissions.status = 'pending'
             )`
        )
        .bind(developer.id, userId);

      let results;
      try {
        results = (await this.db.batch([
          deleteTransfersStmt,
          deleteClaimsStmt,
          deleteDeveloperStmt
        ])) as Array<{
          success: boolean;
          error?: string;
          meta?: { changes?: number };
        }>;
      } catch (error) {
        return databaseError("deleteOwn", error);
      }

      const failed = results.find((r) => !r.success);
      if (failed) {
        return databaseError(
          "deleteOwn",
          new Error(failed.error || "Database write failed")
        );
      }

      const [, , developerResult] = results;
      if (!developerResult.meta?.changes) {
        return {
          data: null,
          error: await this.deletionBlockedError(developer.id, userId)
        };
      }

      return { data: { id: developer.id, deleted: true }, error: null };
    } catch (error) {
      return databaseError("deleteOwn", error);
    }
  }

  async getById(id: string): Promise<DatabaseResult<DeveloperProfile>> {
    try {
      const row = await this.db
        .prepare("SELECT * FROM developers WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      if (!row) {
        return {
          data: null,
          error: {
            message: `Cannot find developer by id: ${id}`,
            code: "NOT_FOUND"
          }
        };
      }
      return { data: parseDeveloperRow(row), error: null };
    } catch (error) {
      return databaseError("getById", error);
    }
  }

  async listAll(): Promise<DatabaseResult<DeveloperProfile[]>> {
    let result;
    try {
      result = await this.db
        .prepare("SELECT * FROM developers ORDER BY name")
        .all<Record<string, unknown>>();
    } catch (error) {
      return databaseError("listAll", error);
    }

    if (!result.success) {
      return databaseError(
        "listAll",
        new Error(result.error || "Database query failed")
      );
    }

    return {
      data: (result.results ?? []).map(parseDeveloperRow),
      error: null
    };
  }

  async listUnapproved(): Promise<DatabaseResult<DeveloperProfile[]>> {
    let result;
    try {
      result = await this.db
        .prepare(
          "SELECT * FROM developers WHERE approved_at IS NULL ORDER BY created_at ASC"
        )
        .all<Record<string, unknown>>();
    } catch (error) {
      return databaseError("listUnapproved", error);
    }

    if (!result.success) {
      return databaseError(
        "listUnapproved",
        new Error(result.error || "Database query failed")
      );
    }

    return {
      data: (result.results ?? []).map(parseDeveloperRow),
      error: null
    };
  }

  async approve(
    id: string,
    expectedRevision: number,
    reviewerId: string
  ): Promise<DatabaseResult<{ id: string; approved: true }>> {
    let result;
    try {
      result = await this.db
        .prepare(
          `UPDATE developers
           SET approved_at = CURRENT_TIMESTAMP,
               approved_revision = content_revision,
               approved_by = ?
           WHERE id = ? AND content_revision = ?`
        )
        .bind(reviewerId, id, expectedRevision)
        .run();
    } catch (error) {
      return databaseError("approve", error);
    }

    if (!result.success) {
      return databaseError(
        "approve",
        new Error(result.error || "Database query failed")
      );
    }

    if (!result.meta?.changes) {
      const existing = await this.getById(id);
      return existing.error
        ? {
            data: null,
            error: {
              message: `Cannot find developer by id: ${id}`,
              code: "NOT_FOUND"
            }
          }
        : {
            data: null,
            error: {
              message:
                "Developer profile changed after it was reviewed; reload it and approve the current revision",
              code: "CONFLICT"
            }
          };
    }

    return { data: { id, approved: true }, error: null };
  }

  async listHistory(
    developerId: string
  ): Promise<DatabaseResult<DeveloperHistoryEntry[]>> {
    let result;
    try {
      result = await this.db
        .prepare(
          // CURRENT_TIMESTAMP has only second resolution, so two writes in
          // the same second tie on changed_at; rowid (insertion order)
          // breaks the tie so "newest first" is never ambiguous.
          `SELECT developer_id, type, name, url, changed_by, changed_at
           FROM developer_history WHERE developer_id = ?
           ORDER BY changed_at DESC, rowid DESC`
        )
        .bind(developerId)
        .all<Record<string, unknown>>();
    } catch (error) {
      return databaseError("listHistory", error);
    }

    if (!result.success) {
      return databaseError(
        "listHistory",
        new Error(result.error || "Database query failed")
      );
    }

    return {
      data: (result.results ?? []).map((row) => ({
        developer_id: row.developer_id as string,
        type: row.type as DeveloperHistoryEntry["type"],
        name: row.name as string,
        URL: (row.url as string | null) ?? undefined,
        changed_by: row.changed_by as string,
        changed_at: row.changed_at as string
      })),
      error: null
    };
  }

  // Shared by initiateTransfer/revokeTransfer: both are owner-only actions on
  // an existing developer, so both need the same NOT_FOUND/FORBIDDEN check.
  private async checkOwnership(
    developerId: string,
    userId: string
  ): Promise<{ code: "NOT_FOUND" | "FORBIDDEN"; message: string } | null> {
    const owner = await this.db
      .prepare("SELECT owner_user_id FROM developers WHERE id = ?")
      .bind(developerId)
      .first<{ owner_user_id: string | null }>();

    if (!owner) {
      return { code: "NOT_FOUND", message: "Developer not found" };
    }
    if (owner.owner_user_id !== userId) {
      return { code: "FORBIDDEN", message: "You don't own this profile" };
    }
    return null;
  }

  async initiateTransfer(
    developerId: string,
    userId: string
  ): Promise<DatabaseResult<DeveloperTransfer>> {
    try {
      const token =
        crypto.randomUUID().replace(/-/g, "") +
        crypto.randomUUID().replace(/-/g, "");
      const tokenHash = await sha256Hex(token);
      const expiresAt = toSqliteDatetime(new Date(Date.now() + 60 * 60 * 1000));

      if (!this.db.batch) {
        return databaseError(
          "initiateTransfer",
          new Error("Database adapter does not support batch operations")
        );
      }

      // Both writes are conditioned on current ownership in the same
      // statement, rather than a separate SELECT beforehand — a caller who
      // loses ownership between an up-front check and the write could
      // otherwise still slip the write through. Superseding any existing
      // pending transfer (rather than stacking up) keeps
      // idx_developer_transfers_pending satisfied without a separate cleanup
      // pass.
      const revokeStmt = this.db
        .prepare(
          `UPDATE developer_transfers SET revoked_at = CURRENT_TIMESTAMP
           WHERE developer_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM developers WHERE developers.id = developer_transfers.developer_id AND developers.owner_user_id = ?)`
        )
        .bind(developerId, userId);
      const insertStmt = this.db
        .prepare(
          `INSERT INTO developer_transfers (id, developer_id, token_hash, created_by, expires_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM developers WHERE id = ? AND owner_user_id = ?)`
        )
        .bind(
          crypto.randomUUID(),
          developerId,
          tokenHash,
          userId,
          expiresAt,
          developerId,
          userId
        );

      const results = (await this.db.batch([revokeStmt, insertStmt])) as Array<{
        success: boolean;
        error?: string;
        meta?: { changes?: number };
      }>;
      const failed = results.find((r) => !r.success);
      if (failed) {
        return databaseError(
          "initiateTransfer",
          new Error(failed.error || "Database write failed")
        );
      }

      // The INSERT only writes a row when the ownership guard above passes,
      // so zero rows written means the caller doesn't currently own this
      // developer — a follow-up read distinguishes NOT_FOUND from FORBIDDEN
      // for the response without reopening the race the guard closes.
      if (!results[1]?.meta?.changes) {
        const ownershipError = await this.checkOwnership(developerId, userId);
        return {
          data: null,
          error: ownershipError ?? {
            code: "FORBIDDEN",
            message: "You don't own this profile"
          }
        };
      }

      return { data: { token, expires_at: expiresAt }, error: null };
    } catch (error) {
      return databaseError("initiateTransfer", error);
    }
  }

  async revokeTransfer(
    developerId: string,
    userId: string
  ): Promise<DatabaseResult<{ id: string; revoked: true }>> {
    try {
      const result = await this.db
        .prepare(
          `UPDATE developer_transfers SET revoked_at = CURRENT_TIMESTAMP
           WHERE developer_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM developers WHERE developers.id = developer_transfers.developer_id AND developers.owner_user_id = ?)`
        )
        .bind(developerId, userId)
        .run();

      if (!result.success) {
        return databaseError(
          "revokeTransfer",
          new Error(result.error || "Database write failed")
        );
      }

      // Zero rows changed is ambiguous by itself (no pending transfer vs.
      // not the owner vs. no such developer), since the ownership guard is
      // folded into the write above rather than checked beforehand. A
      // follow-up read-only check distinguishes them for the response
      // without reopening the race that guard closes.
      if (!result.meta?.changes) {
        const ownershipError = await this.checkOwnership(developerId, userId);
        if (ownershipError) {
          return { data: null, error: ownershipError };
        }
      }

      return { data: { id: developerId, revoked: true }, error: null };
    } catch (error) {
      return databaseError("revokeTransfer", error);
    }
  }

  async acceptTransfer(
    token: string,
    userId: string
  ): Promise<DatabaseResult<DeveloperProfile>> {
    try {
      const tokenHash = await sha256Hex(token);

      if (!this.db.batch) {
        return databaseError(
          "acceptTransfer",
          new Error("Database adapter does not support batch operations")
        );
      }

      // Claim the transfer and move ownership in the same atomic batch,
      // rather than as two separate writes. Splitting them would leave a
      // window, after the claim commits but before ownership actually
      // moves, where the *former* owner's initiateTransfer call would still
      // see itself as the current owner (per the developers row) and could
      // mint a fresh, valid link for a profile that's already mid-handoff.
      // It would also mean a failure on the ownership write alone (e.g. the
      // recipient racing to create another profile) permanently burns the
      // token without ever transferring ownership, with no way to retry.
      // Batching both as one D1 transaction makes them succeed or fail as a
      // unit. The `changes() = 1` guard on the second statement is load-
      // bearing, not redundant with the subquery: accepted_by/accepted_at
      // are a permanent historical record once a token is claimed, so the
      // subquery alone would match a *previously* accepted token forever,
      // letting a replay of an old, already-used link silently reassign
      // ownership again (even to a profile since handed off to someone
      // else) despite the claim itself changing zero rows.
      // `changes()` reports the row count from the immediately preceding
      // statement on this same connection, so it's only 1 when *this*
      // batch's claim just fired — proving the update below is reacting to
      // a fresh claim, not replaying an old one.
      //
      // The claim's NOT EXISTS guard folds the self-accept case (accepting
      // user already owns *this* developer) and the already-owns-a-
      // different-profile case into the same atomic decision, so the token
      // is never consumed unless the accepting user is actually eligible. A
      // plain check-then-act (SELECT the row, decide, then write) would let
      // two concurrent accepts both read it as valid before either one
      // wrote to it, making the token usable more than once.
      const claimStmt = this.db
        .prepare(
          `UPDATE developer_transfers SET accepted_at = CURRENT_TIMESTAMP, accepted_by = ?
           WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
             AND NOT EXISTS (SELECT 1 FROM developers WHERE owner_user_id = ?)`
        )
        .bind(userId, tokenHash, userId);
      const updateDeveloperStmt = this.db
        .prepare(
          `UPDATE developers
           SET owner_user_id = ?,
               ownership_epoch = ownership_epoch + 1,
               content_revision = content_revision + 1,
               approved_at = NULL, approved_revision = NULL, approved_by = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE changes() = 1
             AND id = (
               SELECT developer_id FROM developer_transfers
               WHERE token_hash = ? AND accepted_by = ? AND accepted_at IS NOT NULL
             )`
        )
        .bind(userId, tokenHash, userId);

      const rejectPendingStmt = this.db
        .prepare(
          `UPDATE extension_submissions
           SET status = 'rejected',
               review_note = 'Ownership changed before review',
               reviewed_at = CURRENT_TIMESTAMP
           WHERE changes() = 1
             AND developer_id = (
               SELECT developer_id FROM developer_transfers
               WHERE token_hash = ? AND accepted_by = ? AND accepted_at IS NOT NULL
             )
             AND status = 'pending'`
        )
        .bind(tokenHash, userId);

      let results;
      try {
        results = (await this.db.batch([
          claimStmt,
          updateDeveloperStmt,
          rejectPendingStmt
        ])) as Array<{
          success: boolean;
          error?: string;
          meta?: { changes?: number };
        }>;
      } catch (error) {
        if (isOwnerConflict(error instanceof Error ? error.message : "")) {
          return {
            data: null,
            error: {
              code: "CONFLICT",
              message:
                "You already have a developer profile — remove or transfer it before accepting a new one"
            }
          };
        }
        return databaseError("acceptTransfer", error);
      }

      const failed = results.find((r) => !r.success);
      if (failed) {
        if (isOwnerConflict(failed.error)) {
          return {
            data: null,
            error: {
              code: "CONFLICT",
              message:
                "You already have a developer profile — remove or transfer it before accepting a new one"
            }
          };
        }
        return databaseError(
          "acceptTransfer",
          new Error(failed.error || "Database write failed")
        );
      }

      const [claim] = results;
      if (!claim.meta?.changes) {
        // The claim can fail either because the token itself is bad (used,
        // revoked, expired, unknown) or because it's still valid but the
        // ownership guard rejected it — check which, for an accurate error.
        const stillPending = await this.db
          .prepare(
            `SELECT 1 FROM developer_transfers
             WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`
          )
          .bind(tokenHash)
          .first();

        if (stillPending) {
          return {
            data: null,
            error: {
              code: "CONFLICT",
              message:
                "You already have a developer profile — remove or transfer it before accepting a new one"
            }
          };
        }
        return {
          data: null,
          error: {
            code: "NOT_FOUND",
            message: "This transfer link is invalid, used, or expired"
          }
        };
      }

      const transfer = await this.db
        .prepare(
          "SELECT developer_id FROM developer_transfers WHERE token_hash = ?"
        )
        .bind(tokenHash)
        .first<{ developer_id: string }>();
      if (!transfer) {
        return databaseError(
          "acceptTransfer",
          new Error("Claimed transfer row not found")
        );
      }

      return this.getById(transfer.developer_id);
    } catch (error) {
      return databaseError("acceptTransfer", error);
    }
  }

  private async getClaimById(
    id: string
  ): Promise<DatabaseResult<DeveloperClaim>> {
    try {
      const row = await this.db
        .prepare("SELECT * FROM developer_claims WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      if (!row) {
        return {
          data: null,
          error: {
            message: `Cannot find claim by id: ${id}`,
            code: "NOT_FOUND"
          }
        };
      }
      return { data: parseClaimRow(row), error: null };
    } catch (error) {
      return databaseError("getClaimById", error);
    }
  }

  // Shared by claim/approveClaim once a developer/eligibility-guarded write
  // affects zero rows: distinguishes "no such developer" from the two
  // possible ownership conflicts for an accurate response, without
  // reopening the race the guarded write already closed.
  private async claimIneligibilityError(
    developerId: string
  ): Promise<{ code: "NOT_FOUND" | "CONFLICT"; message: string }> {
    const developer = await this.db
      .prepare("SELECT owner_user_id FROM developers WHERE id = ?")
      .bind(developerId)
      .first<{ owner_user_id: string | null }>();
    if (!developer) {
      return { code: "NOT_FOUND", message: "Developer not found" };
    }
    if (developer.owner_user_id !== null) {
      return { code: "CONFLICT", message: "This profile is already owned" };
    }
    return {
      code: "CONFLICT",
      message: "You already have a developer profile"
    };
  }

  // githubToken authenticates the GitHub entity-existence lookup only (a
  // service-level credential, raises the public rate limit) — it is never
  // the claimant's own token, which never leaves the auth service. Shared by
  // claim() and upsertOwn(): both need the same question answered — does a
  // real GitHub org/user exist for this id, and if so, does the caller's own
  // linked GitHub identity match it? A positive mismatch is the only outcome
  // that ever blocks; no real GitHub entity for this id, or the caller
  // having no linked GitHub identity yet, both fall back to unverified
  // (manual moderator review), never to a block.
  private async verifyGithubOwnership(
    developerId: string,
    developerType: Developer["type"],
    callerId: string,
    githubToken?: string
  ): Promise<
    | { mismatch: true }
    | { mismatch: false; githubOrgVerified: number | null; note: string | null }
    | { error: DatabaseError }
  > {
    const githubEntityType = await checkGithubEntityType(
      developerId,
      githubToken ?? ""
    );

    if (githubEntityType === null) {
      // Also covers a failed lookup (rate limit, network, auth error) —
      // checkGithubEntityType can't tell "confirmed absent" from "couldn't
      // check", so the note can't claim to know no matching entity exists.
      return {
        mismatch: false,
        githubOrgVerified: null,
        note: "GitHub entity was not verified automatically — reviewed manually."
      };
    }

    // A real GitHub entity exists for this id, just under the other type
    // (e.g. a real org submitted as a "user") — this is a confirmed
    // disagreement with GitHub, not an unknown, so it must block rather than
    // fall back to unverified. Otherwise a caller could take a real org/user's
    // id unverified simply by submitting the wrong type for it.
    if (githubEntityType !== developerType) {
      return { mismatch: true };
    }

    const identity = await new UsersDatabase(this.db).getGithubIdentity(
      callerId
    );
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

    if (!callerIdentity.githubLogin) {
      return {
        mismatch: false,
        githubOrgVerified: null,
        note: "Caller has no linked GitHub identity yet — reviewed manually."
      };
    }

    if (matchesClaimant(developerType, developerId, callerIdentity)) {
      return {
        mismatch: false,
        githubOrgVerified: 1,
        note: "Verified: caller's linked GitHub identity matches."
      };
    }

    return { mismatch: true };
  }

  async claim(
    developerId: string,
    claimantId: string,
    note?: string,
    githubToken?: string
  ): Promise<DatabaseResult<DeveloperClaim>> {
    try {
      let githubOrgVerified: number | null = null;
      let githubVerificationNote: string | null = null;

      const developer = await this.db
        .prepare(
          "SELECT type FROM developers WHERE id = ? AND owner_user_id IS NULL"
        )
        .bind(developerId)
        .first<{ type: Developer["type"] }>();

      if (developer) {
        // Cheap short-circuit ahead of the GitHub lookup below: a claimant
        // replaying an already-pending claim on this id would otherwise
        // trigger a fresh GitHub API call every time, purely to be told the
        // INSERT's own guard rejects it as a duplicate — letting one caller
        // burn through the shared service-level GitHub quota for free. This
        // is safe precisely because it only ever *returns* here when the
        // read observes `pending` — it never falls through to verification
        // or the INSERT in that case, so it can't itself create an
        // unverified claim. Anything else (no claim yet, or one already
        // resolved to approved/rejected) always continues through full
        // verification below. A pending claim that resolves between this
        // read and the response going out can make the message stale
        // relative to that instant, but never lets a row get created
        // without verification.
        const hasPendingClaim = await this.db
          .prepare(
            "SELECT 1 FROM developer_claims WHERE developer_id = ? AND claimant_id = ? AND status = 'pending'"
          )
          .bind(developerId, claimantId)
          .first();

        if (hasPendingClaim) {
          return {
            data: null,
            error: {
              code: "CONFLICT",
              message: "You already have a pending claim on this profile"
            }
          };
        }

        const check = await this.verifyGithubOwnership(
          developerId,
          developer.type,
          claimantId,
          githubToken
        );

        if ("error" in check) {
          return { data: null, error: check.error };
        }

        if (check.mismatch) {
          return {
            data: null,
            error: {
              code: "GITHUB_MISMATCH",
              message:
                "Your linked GitHub account doesn't match this developer's GitHub organization or username, so it can't be claimed automatically. Make sure you're signed in with the right GitHub account, then try again."
            }
          };
        }

        githubOrgVerified = check.githubOrgVerified;
        githubVerificationNote = check.note;
      }

      const id = crypto.randomUUID();
      let result;
      try {
        // Both eligibility checks are folded into the INSERT itself, rather
        // than a separate SELECT beforehand — a caller who loses eligibility
        // (developer gets claimed/transferred, or the caller picks up a
        // different profile) between an up-front check and the write could
        // otherwise still slip a stale claim through. (The SELECT above is
        // only used to decide the GitHub verification signal, and is always
        // re-checked here — it can't itself grant eligibility.)
        result = await this.db
          .prepare(
            `INSERT INTO developer_claims (id, developer_id, claimant_id, note, github_org_verified, github_verification_note)
             SELECT ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM developers WHERE id = ? AND owner_user_id IS NULL)
               AND NOT EXISTS (SELECT 1 FROM developers WHERE owner_user_id = ?)`
          )
          .bind(
            id,
            developerId,
            claimantId,
            note ?? null,
            githubOrgVerified,
            githubVerificationNote,
            developerId,
            claimantId
          )
          .run();
      } catch (error) {
        if (
          isPendingClaimConflict(error instanceof Error ? error.message : "")
        ) {
          return {
            data: null,
            error: {
              code: "CONFLICT",
              message: "You already have a pending claim on this profile"
            }
          };
        }
        return databaseError("claim", error);
      }

      if (!result.success) {
        return databaseError(
          "claim",
          new Error(result.error || "Database write failed")
        );
      }

      if (!result.meta?.changes) {
        return {
          data: null,
          error: await this.claimIneligibilityError(developerId)
        };
      }

      return this.getClaimById(id);
    } catch (error) {
      return databaseError("claim", error);
    }
  }

  async listMyClaims(
    claimantId: string
  ): Promise<DatabaseResult<DeveloperClaim[]>> {
    let result;
    try {
      result = await this.db
        .prepare(
          "SELECT * FROM developer_claims WHERE claimant_id = ? ORDER BY created_at DESC"
        )
        .bind(claimantId)
        .all<Record<string, unknown>>();
    } catch (error) {
      return databaseError("listMyClaims", error);
    }

    if (!result.success) {
      return databaseError(
        "listMyClaims",
        new Error(result.error || "Database query failed")
      );
    }

    return {
      data: (result.results ?? []).map(parseClaimRow),
      error: null
    };
  }

  async listPendingClaims(): Promise<DatabaseResult<PendingDeveloperClaim[]>> {
    let result;
    try {
      result = await this.db
        .prepare(
          `SELECT c.*, d.name AS developer_name, d.type AS developer_type
           FROM developer_claims c JOIN developers d ON d.id = c.developer_id
           WHERE c.status = 'pending' ORDER BY c.created_at ASC`
        )
        .all<Record<string, unknown>>();
    } catch (error) {
      return databaseError("listPendingClaims", error);
    }

    if (!result.success) {
      return databaseError(
        "listPendingClaims",
        new Error(result.error || "Database query failed")
      );
    }

    return {
      data: (result.results ?? []).map((row) => ({
        ...parseClaimRow(row),
        developer_name: row.developer_name as string,
        developer_type:
          row.developer_type as PendingDeveloperClaim["developer_type"]
      })),
      error: null
    };
  }

  // Best-effort compensation: if the write-through after claiming the status
  // transition fails, put the claim back to 'pending' rather than leaving it
  // permanently 'approved' with no matching ownership change.
  private async revertClaimToPending(id: string): Promise<void> {
    try {
      await this.db
        .prepare(
          `UPDATE developer_claims SET status = 'pending', reviewer_id = NULL, reviewed_at = NULL
           WHERE id = ?`
        )
        .bind(id)
        .run();
    } catch {
      // best-effort only
    }
  }

  async approveClaim(
    claimId: string,
    reviewerId: string
  ): Promise<DatabaseResult<DeveloperProfile>> {
    const existing = await this.getClaimById(claimId);
    if (existing.error || !existing.data) {
      return {
        data: null,
        error: existing.error ?? {
          message: `Cannot find claim by id: ${claimId}`,
          code: "NOT_FOUND"
        }
      };
    }
    const claim = existing.data;

    if (claim.status !== "pending") {
      return {
        data: null,
        error: { message: "Claim is not pending", code: "CONFLICT" }
      };
    }

    if (!this.db.batch) {
      return databaseError(
        "approveClaim",
        new Error("Database adapter does not support batch operations")
      );
    }

    try {
      const developer = await this.db
        .prepare("SELECT owner_user_id FROM developers WHERE id = ?")
        .bind(claim.developer_id)
        .first<{ owner_user_id: string | null }>();
      if (!developer) {
        return {
          data: null,
          error: { message: "Developer not found", code: "NOT_FOUND" }
        };
      }
      if (developer.owner_user_id !== null) {
        return {
          data: null,
          error: { message: "This profile is already owned", code: "CONFLICT" }
        };
      }

      const conflict = await this.db
        .prepare("SELECT 1 FROM developers WHERE owner_user_id = ?")
        .bind(claim.claimant_id)
        .first();
      if (conflict) {
        return {
          data: null,
          error: {
            message: "The claimant already owns a different developer profile",
            code: "CONFLICT"
          }
        };
      }
    } catch (error) {
      return databaseError("approveClaim", error);
    }

    // Claim the transition atomically before writing anything through. If
    // this affects no rows, a concurrent approve/reject already won the race.
    let claimResult;
    try {
      claimResult = await this.db
        .prepare(
          `UPDATE developer_claims SET status = 'approved', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'pending'`
        )
        .bind(reviewerId, claimId)
        .run();
    } catch (error) {
      return databaseError("approveClaim", error);
    }

    if (!claimResult.success) {
      return databaseError(
        "approveClaim",
        new Error(claimResult.error || "Database query failed")
      );
    }
    if (!claimResult.meta?.changes) {
      return {
        data: null,
        error: { message: "Claim is not pending", code: "CONFLICT" }
      };
    }

    // The ownership write is itself guarded by `owner_user_id IS NULL`, so a
    // second concurrent approval of a *different* pending claim on the same
    // developer (each claim id claims its own status row above, so both
    // could reach this point) can't also move ownership — only the first to
    // commit here wins, and the loser's developerStmt affects zero rows,
    // caught below. rejectOthersStmt is gated on that same win via
    // `changes() = 1`, so competing claims are only auto-rejected once
    // ownership has actually moved, not whenever this batch merely runs.
    let results;
    try {
      const developerStmt = this.db
        .prepare(
          `UPDATE developers
           SET owner_user_id = ?,
               ownership_epoch = ownership_epoch + 1,
               content_revision = content_revision + 1,
               approved_at = NULL, approved_revision = NULL, approved_by = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND owner_user_id IS NULL`
        )
        .bind(claim.claimant_id, claim.developer_id);
      const rejectOthersStmt = this.db
        .prepare(
          `UPDATE developer_claims SET status = 'rejected', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP,
             review_note = 'Another claim on this profile was approved'
           WHERE changes() = 1 AND developer_id = ? AND status = 'pending' AND id != ?`
        )
        .bind(reviewerId, claim.developer_id, claimId);

      results = (await this.db.batch([
        developerStmt,
        rejectOthersStmt
      ])) as Array<{
        success: boolean;
        error?: string;
        meta?: { changes?: number };
      }>;
    } catch (error) {
      await this.revertClaimToPending(claimId);
      return databaseError("approveClaim", error);
    }

    const failed = results.find((r) => !r.success);
    if (failed) {
      await this.revertClaimToPending(claimId);
      return databaseError(
        "approveClaim",
        new Error(failed.error || "Database write failed")
      );
    }

    const [developerResult] = results;
    if (!developerResult.meta?.changes) {
      await this.revertClaimToPending(claimId);
      return {
        data: null,
        error: {
          message: "This profile is no longer unowned",
          code: "CONFLICT"
        }
      };
    }

    return this.getById(claim.developer_id);
  }

  async rejectClaim(
    claimId: string,
    reviewerId: string,
    reviewNote: string
  ): Promise<DatabaseResult<DeveloperClaim>> {
    let result;
    try {
      result = await this.db
        .prepare(
          `UPDATE developer_claims SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'pending'`
        )
        .bind(reviewerId, reviewNote, claimId)
        .run();
    } catch (error) {
      return databaseError("rejectClaim", error);
    }

    if (!result.success) {
      return databaseError(
        "rejectClaim",
        new Error(result.error || "Database query failed")
      );
    }

    if (!result.meta?.changes) {
      return {
        data: null,
        error: {
          message: `Cannot find pending claim by id: ${claimId}`,
          code: "NOT_FOUND"
        }
      };
    }

    return this.getClaimById(claimId);
  }
}
