import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
import { Submission, SubmissionPayload, SubmissionStatus } from "./interfaces";

interface OwnershipResolution {
  extensionId: string | null;
  authorId: string;
}

interface CreateInput {
  extensionId: string | null;
  authorId: string;
  submittedBy: string;
  payload: SubmissionPayload;
}

function databaseError(error: unknown): DatabaseResult<never> {
  return {
    data: null,
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: "DATABASE_ERROR"
    }
  };
}

function parseSubmissionRow(row: Record<string, unknown>): Submission {
  return {
    id: row.id as string,
    extension_id: (row.extension_id as string | null) ?? null,
    author_id: row.author_id as string,
    submitted_by: row.submitted_by as string,
    status: row.status as SubmissionStatus,
    payload: JSON.parse(row.payload as string) as SubmissionPayload,
    reviewer_id: (row.reviewer_id as string | null) ?? null,
    review_note: (row.review_note as string | null) ?? null,
    created_at: row.created_at as string,
    reviewed_at: (row.reviewed_at as string | null) ?? null
  };
}

export class SubmissionsDatabase {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  // Edits require owning the extension's current author; the author named in
  // the payload (create, or an edit naming a different author) must be owned
  // by the caller if it already exists, or is free to claim if it doesn't.
  async resolveOwnership(
    payload: SubmissionPayload,
    callerId: string
  ): Promise<DatabaseResult<OwnershipResolution>> {
    try {
      const existingExtension = await this.db
        .prepare(
          "SELECT id, author_id FROM extensions WHERE LOWER(id) = LOWER(?)"
        )
        .bind(payload.extension.id)
        .first<{ id: string; author_id: string }>();

      let extensionId: string | null = null;

      if (existingExtension) {
        const existingAuthor = await this.db
          .prepare("SELECT owner_user_id FROM authors WHERE id = ?")
          .bind(existingExtension.author_id)
          .first<{ owner_user_id: string | null }>();

        if (!existingAuthor || existingAuthor.owner_user_id !== callerId) {
          return {
            data: null,
            error: {
              message: "You do not own the author of this extension",
              code: "FORBIDDEN"
            }
          };
        }

        extensionId = existingExtension.id;
      }

      const payloadAuthor = await this.db
        .prepare("SELECT owner_user_id FROM authors WHERE id = ?")
        .bind(payload.author.id)
        .first<{ owner_user_id: string | null }>();

      if (payloadAuthor && payloadAuthor.owner_user_id !== callerId) {
        return {
          data: null,
          error: { message: "You do not own this author", code: "FORBIDDEN" }
        };
      }

      return {
        data: { extensionId, authorId: payload.author.id },
        error: null
      };
    } catch (error) {
      return databaseError(error);
    }
  }

  async create(input: CreateInput): Promise<DatabaseResult<{ id: string }>> {
    const id = crypto.randomUUID();

    try {
      const result = await this.db
        .prepare(
          `INSERT INTO extension_submissions (id, extension_id, author_id, submitted_by, status, payload)
           VALUES (?, ?, ?, ?, 'pending', ?)`
        )
        .bind(
          id,
          input.extensionId,
          input.authorId,
          input.submittedBy,
          JSON.stringify(input.payload)
        )
        .run();

      if (!result.success) {
        return {
          data: null,
          error: {
            message: result.error || "Database query failed",
            code: "DATABASE_ERROR"
          }
        };
      }
    } catch (error) {
      return databaseError(error);
    }

    return { data: { id }, error: null };
  }

  async listBySubmitter(userId: string): Promise<DatabaseResult<Submission[]>> {
    let result;
    try {
      result = await this.db
        .prepare(
          "SELECT * FROM extension_submissions WHERE submitted_by = ? ORDER BY created_at DESC"
        )
        .bind(userId)
        .all<Record<string, unknown>>();
    } catch (error) {
      return databaseError(error);
    }

    if (!result.success) {
      return {
        data: null,
        error: {
          message: result.error || "Database query failed",
          code: "DATABASE_ERROR"
        }
      };
    }

    return {
      data: (result.results ?? []).map(parseSubmissionRow),
      error: null
    };
  }

  async listQueue(
    status: SubmissionStatus = "pending"
  ): Promise<DatabaseResult<Submission[]>> {
    let result;
    try {
      result = await this.db
        .prepare(
          "SELECT * FROM extension_submissions WHERE status = ? ORDER BY created_at ASC"
        )
        .bind(status)
        .all<Record<string, unknown>>();
    } catch (error) {
      return databaseError(error);
    }

    if (!result.success) {
      return {
        data: null,
        error: {
          message: result.error || "Database query failed",
          code: "DATABASE_ERROR"
        }
      };
    }

    return {
      data: (result.results ?? []).map(parseSubmissionRow),
      error: null
    };
  }

  async getById(id: string): Promise<DatabaseResult<Submission>> {
    let row;
    try {
      row = await this.db
        .prepare("SELECT * FROM extension_submissions WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
    } catch (error) {
      return databaseError(error);
    }

    if (!row) {
      return {
        data: null,
        error: {
          message: `Cannot find submission by id: ${id}`,
          code: "NOT_FOUND"
        }
      };
    }

    return { data: parseSubmissionRow(row), error: null };
  }

  async reject(
    id: string,
    reviewerId: string,
    reviewNote: string
  ): Promise<DatabaseResult<{ id: string; status: "rejected" }>> {
    const existing = await this.getById(id);
    if (existing.error || !existing.data) {
      return {
        data: null,
        error: existing.error ?? {
          message: `Cannot find submission by id: ${id}`,
          code: "NOT_FOUND"
        }
      };
    }

    if (existing.data.status !== "pending") {
      return {
        data: null,
        error: { message: "Submission is not pending", code: "CONFLICT" }
      };
    }

    try {
      await this.db
        .prepare(
          `UPDATE extension_submissions
           SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .bind(reviewerId, reviewNote, id)
        .run();
    } catch (error) {
      return databaseError(error);
    }

    return { data: { id, status: "rejected" }, error: null };
  }

  // Re-checks ownership/availability (may have shifted since submission),
  // then upserts through to authors/extensions in one atomic batch — the
  // upsert form means create vs. edit needs no branching in the SQL.
  async approve(
    id: string,
    reviewerId: string,
    reviewNote?: string
  ): Promise<DatabaseResult<{ id: string; status: "approved" }>> {
    const existing = await this.getById(id);
    if (existing.error || !existing.data) {
      return {
        data: null,
        error: existing.error ?? {
          message: `Cannot find submission by id: ${id}`,
          code: "NOT_FOUND"
        }
      };
    }
    const submission = existing.data;

    if (submission.status !== "pending") {
      return {
        data: null,
        error: { message: "Submission is not pending", code: "CONFLICT" }
      };
    }

    const recheck = await this.resolveOwnership(
      submission.payload,
      submission.submitted_by
    );
    if (recheck.error || !recheck.data) {
      return {
        data: null,
        error: {
          message: recheck.error?.message ?? "Unable to re-validate ownership",
          code: "CONFLICT"
        }
      };
    }

    const wasEdit = submission.extension_id !== null;
    const isStillEdit = recheck.data.extensionId !== null;
    if (wasEdit !== isStillEdit) {
      return {
        data: null,
        error: {
          message: wasEdit
            ? "Extension no longer exists"
            : "Extension id is now taken",
          code: "CONFLICT"
        }
      };
    }

    const { author, extension } = submission.payload;

    if (!this.db.batch) {
      return {
        data: null,
        error: {
          message: "Database adapter does not support batch operations",
          code: "DATABASE_ERROR"
        }
      };
    }

    try {
      const authorStmt = this.db
        .prepare(
          `INSERT INTO authors (id, type, name, url, owner_user_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             type = excluded.type, name = excluded.name, url = excluded.url`
        )
        .bind(
          author.id,
          author.type,
          author.name,
          author.url ?? null,
          submission.submitted_by
        );

      const extensionStmt = this.db
        .prepare(
          `INSERT INTO extensions (id, type, author_id, name, description, releases, website, license, icon_url, readme, source, version, download_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             type = excluded.type, author_id = excluded.author_id, name = excluded.name,
             description = excluded.description, releases = excluded.releases,
             website = excluded.website, license = excluded.license,
             icon_url = excluded.icon_url, readme = excluded.readme,
             source = excluded.source, version = excluded.version,
             download_url = excluded.download_url`
        )
        .bind(
          extension.id,
          extension.type,
          author.id,
          extension.name,
          extension.description,
          JSON.stringify(extension.releases),
          extension.website,
          JSON.stringify(extension.license),
          extension.icon_url ?? null,
          extension.readme,
          JSON.stringify(extension.source),
          extension.version,
          extension.download_url
        );

      const submissionStmt = this.db
        .prepare(
          `UPDATE extension_submissions
           SET status = 'approved', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .bind(reviewerId, reviewNote ?? null, id);

      await this.db.batch([authorStmt, extensionStmt, submissionStmt]);
    } catch (error) {
      return databaseError(error);
    }

    return { data: { id, status: "approved" }, error: null };
  }
}
