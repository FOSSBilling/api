import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
import { databaseError } from "./errors";
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
      return databaseError("resolveOwnership", error);
    }
  }

  async create(input: CreateInput): Promise<DatabaseResult<{ id: string }>> {
    const id = crypto.randomUUID();

    let result;
    try {
      result = await this.db
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
    } catch (error) {
      return databaseError("create", error);
    }

    if (!result.success) {
      return databaseError(
        "create",
        new Error(result.error || "Database query failed")
      );
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
      return databaseError("listBySubmitter", error);
    }

    if (!result.success) {
      return databaseError(
        "listBySubmitter",
        new Error(result.error || "Database query failed")
      );
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
      return databaseError("listQueue", error);
    }

    if (!result.success) {
      return databaseError(
        "listQueue",
        new Error(result.error || "Database query failed")
      );
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
      return databaseError("getById", error);
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

  // Best-effort compensation: if the write-through after a successful claim
  // fails, put the submission back to 'pending' rather than leaving it
  // permanently 'approved' with no matching author/extension write. If this
  // itself fails, the submission is stuck 'approved' and needs manual fixup —
  // surfaced via the DATABASE_ERROR the caller already returns.
  private async revertToPending(id: string): Promise<void> {
    try {
      await this.db
        .prepare(
          `UPDATE extension_submissions
           SET status = 'pending', reviewer_id = NULL, review_note = NULL, reviewed_at = NULL
           WHERE id = ?`
        )
        .bind(id)
        .run();
    } catch {
      // best-effort only
    }
  }

  // Notes what happened to an id-scoped write that didn't affect any rows:
  // either it never existed, or someone else already moved it off 'pending'.
  private async explainNoOpTransition(
    id: string
  ): Promise<DatabaseResult<never>> {
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
    return {
      data: null,
      error: { message: "Submission is not pending", code: "CONFLICT" }
    };
  }

  // The `AND status = 'pending'` guard makes this a single atomic
  // check-and-set: if two moderators race, only one's update affects a row.
  async reject(
    id: string,
    reviewerId: string,
    reviewNote: string
  ): Promise<DatabaseResult<{ id: string; status: "rejected" }>> {
    let result;
    try {
      result = await this.db
        .prepare(
          `UPDATE extension_submissions
           SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'pending'`
        )
        .bind(reviewerId, reviewNote, id)
        .run();
    } catch (error) {
      return databaseError("reject", error);
    }

    if (!result.success) {
      return databaseError(
        "reject",
        new Error(result.error || "Database query failed")
      );
    }

    if (!result.meta?.changes) {
      return this.explainNoOpTransition(id);
    }

    return { data: { id, status: "rejected" }, error: null };
  }

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

    // Claim the transition atomically before writing anything through. If
    // this affects no rows, a concurrent approve/reject already won the
    // race — report CONFLICT without having touched authors/extensions.
    let claim;
    try {
      claim = await this.db
        .prepare(
          `UPDATE extension_submissions
           SET status = 'approved', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'pending'`
        )
        .bind(reviewerId, reviewNote ?? null, id)
        .run();
    } catch (error) {
      return databaseError("approve", error);
    }

    if (!claim.success) {
      return databaseError(
        "approve",
        new Error(claim.error || "Database query failed")
      );
    }

    if (!claim.meta?.changes) {
      return this.explainNoOpTransition(id);
    }

    if (!this.db.batch) {
      await this.revertToPending(id);
      return databaseError(
        "approve",
        new Error("Database adapter does not support batch operations")
      );
    }

    const { author, extension } = submission.payload;
    // Edits must update the existing row even if it was stored under a
    // different case (e.g. legacy "Example" edited via "example") — using
    // the payload's id here would insert a second row instead.
    const extensionId = recheck.data.extensionId ?? extension.id;

    let results;
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
          author.URL ?? null,
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
          extensionId,
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

      results = (await this.db.batch([authorStmt, extensionStmt])) as Array<{
        success: boolean;
        error?: string;
      }>;
    } catch (error) {
      await this.revertToPending(id);
      return databaseError("approve", error);
    }

    const failed = results.find((r) => !r.success);
    if (failed) {
      await this.revertToPending(id);
      return databaseError(
        "approve",
        new Error(failed.error || "Database write failed")
      );
    }

    return { data: { id, status: "approved" }, error: null };
  }
}
