import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
import { databaseError } from "./errors";
import {
  Author,
  AuthorHistoryEntry,
  AuthorProfile,
  AuthorTransfer
} from "./interfaces";

// Matches the SQLite/D1 message for the idx_authors_owner_unique violation,
// which is how a lost race between two concurrent first-time PUT /authors/me
// requests (same caller, different ids) surfaces.
function isOwnerConflict(message: string | undefined): boolean {
  return !!message && /UNIQUE constraint failed.*owner_user_id/i.test(message);
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
      // unit: the second statement's subquery only resolves once the first
      // has actually claimed the row, so there's nothing to update if the
      // claim didn't happen, and a failure on either rolls back both.
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
           WHERE id = (
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
}
