import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
import { databaseError } from "./errors";
import {
  Author,
  AuthorClaim,
  AuthorHistoryEntry,
  AuthorProfile,
  AuthorTransfer,
  PendingAuthorClaim
} from "./interfaces";

// Matches the SQLite/D1 message for the idx_authors_owner_unique violation,
// which is how a lost race between two concurrent first-time PUT /authors/me
// requests (same caller, different ids) surfaces.
function isOwnerConflict(message: string | undefined): boolean {
  return !!message && /UNIQUE constraint failed.*owner_user_id/i.test(message);
}

// Matches the SQLite/D1 message for the idx_author_claims_pending_unique
// violation, which is how a duplicate claim() call while one is already
// pending surfaces.
function isPendingClaimConflict(message: string | undefined): boolean {
  return !!message && /UNIQUE constraint failed.*author_claims/i.test(message);
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

function parseAuthorRow(row: Record<string, unknown>): AuthorProfile {
  return {
    id: row.id as string,
    type: row.type as AuthorProfile["type"],
    name: row.name as string,
    URL: (row.url as string | null) ?? undefined,
    bio: (row.bio as string | null) ?? undefined,
    avatar_url: (row.avatar_url as string | null) ?? undefined,
    contact_email: (row.contact_email as string | null) ?? undefined,
    approved: row.approved_at !== null && row.approved_at !== undefined
  };
}

function parseClaimRow(row: Record<string, unknown>): AuthorClaim {
  return {
    id: row.id as string,
    author_id: row.author_id as string,
    claimant_id: row.claimant_id as string,
    status: row.status as AuthorClaim["status"],
    note: (row.note as string | null) ?? undefined,
    review_note: (row.review_note as string | null) ?? undefined,
    reviewer_id: (row.reviewer_id as string | null) ?? undefined,
    created_at: row.created_at as string,
    reviewed_at: (row.reviewed_at as string | null) ?? undefined
  };
}

export class AuthorsDatabase {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  async upsertOwn(
    userId: string,
    author: Author
  ): Promise<DatabaseResult<AuthorProfile>> {
    try {
      const existingOwn = await this.db
        .prepare("SELECT * FROM authors WHERE owner_user_id = ?")
        .bind(userId)
        .first<Record<string, unknown>>();

      const existingById = await this.db
        .prepare("SELECT * FROM authors WHERE id = ?")
        .bind(author.id)
        .first<Record<string, unknown>>();

      let mainStmt;
      if (!existingOwn) {
        if (existingById) {
          return {
            data: null,
            error: { message: "Author id already exists", code: "CONFLICT" }
          };
        }

        mainStmt = this.db
          .prepare(
            `INSERT INTO authors (id, type, name, url, bio, avatar_url, contact_email, owner_user_id, approved_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
          )
          .bind(
            author.id,
            author.type,
            author.name,
            author.URL ?? null,
            author.bio ?? null,
            author.avatar_url ?? null,
            author.contact_email ?? null,
            userId
          );
      } else {
        if (author.id !== existingOwn.id) {
          return {
            data: null,
            error: {
              message: "Author id cannot be changed",
              code: "CONFLICT"
            }
          };
        }

        // approved_at is always cleared here, even if nothing meaningful
        // changed — the reviewed content just got overwritten, so the old
        // approval no longer applies. Not worth diffing old vs. new values.
        mainStmt = this.db
          .prepare(
            `UPDATE authors SET type = ?, name = ?, url = ?, bio = ?, avatar_url = ?, contact_email = ?, approved_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .bind(
            author.type,
            author.name,
            author.URL ?? null,
            author.bio ?? null,
            author.avatar_url ?? null,
            author.contact_email ?? null,
            author.id
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
          `INSERT INTO author_history (id, author_id, type, name, url, changed_by, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        )
        .bind(
          crypto.randomUUID(),
          author.id,
          author.type,
          author.name,
          author.URL ?? null,
          userId
        );

      let results;
      try {
        results = (await this.db.batch([mainStmt, historyStmt])) as Array<{
          success: boolean;
          error?: string;
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

      return this.getById(author.id);
    } catch (error) {
      return databaseError("upsertOwn", error);
    }
  }

  private async getById(id: string): Promise<DatabaseResult<AuthorProfile>> {
    try {
      const row = await this.db
        .prepare("SELECT * FROM authors WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      if (!row) {
        return {
          data: null,
          error: {
            message: `Cannot find author by id: ${id}`,
            code: "NOT_FOUND"
          }
        };
      }
      return { data: parseAuthorRow(row), error: null };
    } catch (error) {
      return databaseError("getById", error);
    }
  }

  async listAll(): Promise<DatabaseResult<AuthorProfile[]>> {
    let result;
    try {
      result = await this.db
        .prepare("SELECT * FROM authors ORDER BY name")
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
      data: (result.results ?? []).map(parseAuthorRow),
      error: null
    };
  }

  async listUnapproved(): Promise<DatabaseResult<AuthorProfile[]>> {
    let result;
    try {
      result = await this.db
        .prepare(
          "SELECT * FROM authors WHERE approved_at IS NULL ORDER BY created_at ASC"
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
      data: (result.results ?? []).map(parseAuthorRow),
      error: null
    };
  }

  async approve(
    id: string
  ): Promise<DatabaseResult<{ id: string; approved: true }>> {
    let result;
    try {
      result = await this.db
        .prepare(
          "UPDATE authors SET approved_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .bind(id)
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
      return {
        data: null,
        error: { message: `Cannot find author by id: ${id}`, code: "NOT_FOUND" }
      };
    }

    return { data: { id, approved: true }, error: null };
  }

  async listHistory(
    authorId: string
  ): Promise<DatabaseResult<AuthorHistoryEntry[]>> {
    let result;
    try {
      result = await this.db
        .prepare(
          // CURRENT_TIMESTAMP has only second resolution, so two writes in
          // the same second tie on changed_at; rowid (insertion order)
          // breaks the tie so "newest first" is never ambiguous.
          `SELECT author_id, type, name, url, changed_by, changed_at
           FROM author_history WHERE author_id = ?
           ORDER BY changed_at DESC, rowid DESC`
        )
        .bind(authorId)
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
        author_id: row.author_id as string,
        type: row.type as AuthorHistoryEntry["type"],
        name: row.name as string,
        URL: (row.url as string | null) ?? undefined,
        changed_by: row.changed_by as string,
        changed_at: row.changed_at as string
      })),
      error: null
    };
  }

  // Shared by initiateTransfer/revokeTransfer: both are owner-only actions on
  // an existing author, so both need the same NOT_FOUND/FORBIDDEN check.
  private async checkOwnership(
    authorId: string,
    userId: string
  ): Promise<{ code: "NOT_FOUND" | "FORBIDDEN"; message: string } | null> {
    const owner = await this.db
      .prepare("SELECT owner_user_id FROM authors WHERE id = ?")
      .bind(authorId)
      .first<{ owner_user_id: string | null }>();

    if (!owner) {
      return { code: "NOT_FOUND", message: "Author not found" };
    }
    if (owner.owner_user_id !== userId) {
      return { code: "FORBIDDEN", message: "You don't own this profile" };
    }
    return null;
  }

  async initiateTransfer(
    authorId: string,
    userId: string
  ): Promise<DatabaseResult<AuthorTransfer>> {
    try {
      const token =
        crypto.randomUUID().replace(/-/g, "") +
        crypto.randomUUID().replace(/-/g, "");
      const tokenHash = await sha256Hex(token);
      const expiresAt = toSqliteDatetime(
        new Date(Date.now() + 24 * 60 * 60 * 1000)
      );

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
      // idx_author_transfers_pending satisfied without a separate cleanup
      // pass.
      const revokeStmt = this.db
        .prepare(
          `UPDATE author_transfers SET revoked_at = CURRENT_TIMESTAMP
           WHERE author_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM authors WHERE authors.id = author_transfers.author_id AND authors.owner_user_id = ?)`
        )
        .bind(authorId, userId);
      const insertStmt = this.db
        .prepare(
          `INSERT INTO author_transfers (id, author_id, token_hash, created_by, expires_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM authors WHERE id = ? AND owner_user_id = ?)`
        )
        .bind(
          crypto.randomUUID(),
          authorId,
          tokenHash,
          userId,
          expiresAt,
          authorId,
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
      // author — a follow-up read distinguishes NOT_FOUND from FORBIDDEN for
      // the response without reopening the race the guard closes.
      if (!results[1]?.meta?.changes) {
        const ownershipError = await this.checkOwnership(authorId, userId);
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
    authorId: string,
    userId: string
  ): Promise<DatabaseResult<{ id: string; revoked: true }>> {
    try {
      const result = await this.db
        .prepare(
          `UPDATE author_transfers SET revoked_at = CURRENT_TIMESTAMP
           WHERE author_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM authors WHERE authors.id = author_transfers.author_id AND authors.owner_user_id = ?)`
        )
        .bind(authorId, userId)
        .run();

      if (!result.success) {
        return databaseError(
          "revokeTransfer",
          new Error(result.error || "Database write failed")
        );
      }

      // Zero rows changed is ambiguous by itself (no pending transfer vs.
      // not the owner vs. no such author), since the ownership guard is
      // folded into the write above rather than checked beforehand. A
      // follow-up read-only check distinguishes them for the response
      // without reopening the race that guard closes.
      if (!result.meta?.changes) {
        const ownershipError = await this.checkOwnership(authorId, userId);
        if (ownershipError) {
          return { data: null, error: ownershipError };
        }
      }

      return { data: { id: authorId, revoked: true }, error: null };
    } catch (error) {
      return databaseError("revokeTransfer", error);
    }
  }

  async acceptTransfer(
    token: string,
    userId: string
  ): Promise<DatabaseResult<AuthorProfile>> {
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
      // see itself as the current owner (per the authors row) and could
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
      // user already owns *this* author) and the already-owns-a-different-
      // profile case into the same atomic decision, so the token is never
      // consumed unless the accepting user is actually eligible. A plain
      // check-then-act (SELECT the row, decide, then write) would let two
      // concurrent accepts both read it as valid before either one wrote to
      // it, making the token usable more than once.
      const claimStmt = this.db
        .prepare(
          `UPDATE author_transfers SET accepted_at = CURRENT_TIMESTAMP, accepted_by = ?
           WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
             AND NOT EXISTS (SELECT 1 FROM authors WHERE owner_user_id = ?)`
        )
        .bind(userId, tokenHash, userId);
      const updateAuthorStmt = this.db
        .prepare(
          `UPDATE authors SET owner_user_id = ?, approved_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE changes() = 1
             AND id = (
               SELECT author_id FROM author_transfers
               WHERE token_hash = ? AND accepted_by = ? AND accepted_at IS NOT NULL
             )`
        )
        .bind(userId, tokenHash, userId);

      let results;
      try {
        results = (await this.db.batch([
          claimStmt,
          updateAuthorStmt
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
            `SELECT 1 FROM author_transfers
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
        .prepare("SELECT author_id FROM author_transfers WHERE token_hash = ?")
        .bind(tokenHash)
        .first<{ author_id: string }>();
      if (!transfer) {
        return databaseError(
          "acceptTransfer",
          new Error("Claimed transfer row not found")
        );
      }

      return this.getById(transfer.author_id);
    } catch (error) {
      return databaseError("acceptTransfer", error);
    }
  }

  private async getClaimById(id: string): Promise<DatabaseResult<AuthorClaim>> {
    try {
      const row = await this.db
        .prepare("SELECT * FROM author_claims WHERE id = ?")
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

  // Shared by claim/approveClaim once an author/eligibility-guarded write
  // affects zero rows: distinguishes "no such author" from the two possible
  // ownership conflicts for an accurate response, without reopening the
  // race the guarded write already closed.
  private async claimIneligibilityError(
    authorId: string
  ): Promise<{ code: "NOT_FOUND" | "CONFLICT"; message: string }> {
    const author = await this.db
      .prepare("SELECT owner_user_id FROM authors WHERE id = ?")
      .bind(authorId)
      .first<{ owner_user_id: string | null }>();
    if (!author) {
      return { code: "NOT_FOUND", message: "Author not found" };
    }
    if (author.owner_user_id !== null) {
      return { code: "CONFLICT", message: "This profile is already owned" };
    }
    return {
      code: "CONFLICT",
      message: "You already have a developer profile"
    };
  }

  async claim(
    authorId: string,
    claimantId: string,
    note?: string
  ): Promise<DatabaseResult<AuthorClaim>> {
    try {
      const id = crypto.randomUUID();
      let result;
      try {
        // Both eligibility checks are folded into the INSERT itself, rather
        // than a separate SELECT beforehand — a caller who loses eligibility
        // (author gets claimed/transferred, or the caller picks up a
        // different profile) between an up-front check and the write could
        // otherwise still slip a stale claim through.
        result = await this.db
          .prepare(
            `INSERT INTO author_claims (id, author_id, claimant_id, note)
             SELECT ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM authors WHERE id = ? AND owner_user_id IS NULL)
               AND NOT EXISTS (SELECT 1 FROM authors WHERE owner_user_id = ?)`
          )
          .bind(id, authorId, claimantId, note ?? null, authorId, claimantId)
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
          error: await this.claimIneligibilityError(authorId)
        };
      }

      return this.getClaimById(id);
    } catch (error) {
      return databaseError("claim", error);
    }
  }

  async listMyClaims(
    claimantId: string
  ): Promise<DatabaseResult<AuthorClaim[]>> {
    let result;
    try {
      result = await this.db
        .prepare(
          "SELECT * FROM author_claims WHERE claimant_id = ? ORDER BY created_at DESC"
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

  async listPendingClaims(): Promise<DatabaseResult<PendingAuthorClaim[]>> {
    let result;
    try {
      result = await this.db
        .prepare(
          `SELECT c.*, a.name AS author_name, a.type AS author_type
           FROM author_claims c JOIN authors a ON a.id = c.author_id
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
        author_name: row.author_name as string,
        author_type: row.author_type as PendingAuthorClaim["author_type"]
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
          `UPDATE author_claims SET status = 'pending', reviewer_id = NULL, reviewed_at = NULL
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
  ): Promise<DatabaseResult<AuthorProfile>> {
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
      const author = await this.db
        .prepare("SELECT owner_user_id FROM authors WHERE id = ?")
        .bind(claim.author_id)
        .first<{ owner_user_id: string | null }>();
      if (!author) {
        return {
          data: null,
          error: { message: "Author not found", code: "NOT_FOUND" }
        };
      }
      if (author.owner_user_id !== null) {
        return {
          data: null,
          error: { message: "This profile is already owned", code: "CONFLICT" }
        };
      }

      const conflict = await this.db
        .prepare("SELECT 1 FROM authors WHERE owner_user_id = ?")
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
          `UPDATE author_claims SET status = 'approved', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP
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
    // author (each claim id claims its own status row above, so both could
    // reach this point) can't also move ownership — only the first to commit
    // here wins, and the loser's authorStmt affects zero rows, caught below.
    // rejectOthersStmt is gated on that same win via `changes() = 1`, so
    // competing claims are only auto-rejected once ownership has actually
    // moved, not whenever this batch merely runs.
    let results;
    try {
      const authorStmt = this.db
        .prepare(
          `UPDATE authors SET owner_user_id = ?, approved_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND owner_user_id IS NULL`
        )
        .bind(claim.claimant_id, claim.author_id);
      const rejectOthersStmt = this.db
        .prepare(
          `UPDATE author_claims SET status = 'rejected', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP,
             review_note = 'Another claim on this profile was approved'
           WHERE changes() = 1 AND author_id = ? AND status = 'pending' AND id != ?`
        )
        .bind(reviewerId, claim.author_id, claimId);

      results = (await this.db.batch([authorStmt, rejectOthersStmt])) as Array<{
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

    const [authorResult] = results;
    if (!authorResult.meta?.changes) {
      await this.revertClaimToPending(claimId);
      return {
        data: null,
        error: {
          message: "This profile is no longer unowned",
          code: "CONFLICT"
        }
      };
    }

    return this.getById(claim.author_id);
  }

  async rejectClaim(
    claimId: string,
    reviewerId: string,
    reviewNote: string
  ): Promise<DatabaseResult<AuthorClaim>> {
    let result;
    try {
      result = await this.db
        .prepare(
          `UPDATE author_claims SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
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
