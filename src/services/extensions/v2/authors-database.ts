import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
import { databaseError } from "./errors";
import { Author, AuthorHistoryEntry, AuthorProfile } from "./interfaces";

// Matches the SQLite/D1 message for the idx_authors_owner_unique violation,
// which is how a lost race between two concurrent first-time PUT /authors/me
// requests (same caller, different ids) surfaces.
function isOwnerConflict(message: string | undefined): boolean {
  return !!message && /UNIQUE constraint failed.*owner_user_id/i.test(message);
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
}
