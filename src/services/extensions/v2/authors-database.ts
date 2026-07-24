import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
import { databaseError } from "./errors";
import { Author, AuthorProfile } from "./interfaces";

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

  async getOwn(userId: string): Promise<DatabaseResult<AuthorProfile | null>> {
    try {
      const row = await this.db
        .prepare("SELECT * FROM authors WHERE owner_user_id = ?")
        .bind(userId)
        .first<Record<string, unknown>>();
      return { data: row ? parseAuthorRow(row) : null, error: null };
    } catch (error) {
      return databaseError("getOwn", error);
    }
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

      if (!existingOwn) {
        if (existingById) {
          return {
            data: null,
            error: { message: "Author id already exists", code: "CONFLICT" }
          };
        }

        const result = await this.db
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
          )
          .run();

        if (!result.success) {
          return databaseError(
            "upsertOwn",
            new Error(result.error || "Database query failed")
          );
        }
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
        const result = await this.db
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
          )
          .run();

        if (!result.success) {
          return databaseError(
            "upsertOwn",
            new Error(result.error || "Database query failed")
          );
        }
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
}
