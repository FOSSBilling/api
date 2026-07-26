import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
import { databaseError } from "./errors";
import { Submission, SubmissionPayload, SubmissionStatus } from "./interfaces";

interface OwnershipResolution {
  extensionId: string | null;
  developerId: string;
  ownershipEpoch: number;
}

interface CreateInput {
  extensionId: string | null;
  developerId: string;
  ownershipEpoch: number;
  submittedBy: string;
  payload: SubmissionPayload;
}

export interface SubmissionPage {
  items: Submission[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface StoredSubmission extends Submission {
  ownershipEpoch: number;
}

const MAX_PENDING_SUBMISSIONS_PER_USER = 10;

function isPendingTargetConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed.*extension_submissions/i.test(error.message)
  );
}

function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify([createdAt, id]));
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const value = JSON.parse(atob(cursor)) as unknown;
    return Array.isArray(value) &&
      value.length === 2 &&
      value.every((part) => typeof part === "string")
      ? (value as [string, string])
      : null;
  } catch {
    return null;
  }
}

function parseSubmissionRow(row: Record<string, unknown>): StoredSubmission {
  const submission = {
    id: row.id as string,
    extension_id: (row.extension_id as string | null) ?? null,
    developer_id: row.developer_id as string,
    submitted_by: row.submitted_by as string,
    status: row.status as SubmissionStatus,
    payload: JSON.parse(row.payload as string) as SubmissionPayload,
    reviewer_id: (row.reviewer_id as string | null) ?? null,
    review_note: (row.review_note as string | null) ?? null,
    created_at: row.created_at as string,
    reviewed_at: (row.reviewed_at as string | null) ?? null
  } as StoredSubmission;
  Object.defineProperty(submission, "ownershipEpoch", {
    value: Number(row.ownership_epoch ?? 1),
    enumerable: false
  });
  return submission;
}

export class SubmissionsDatabase {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  // Edits require owning the extension's current developer; the developer
  // named in the payload (create, or an edit naming a different developer)
  // must be owned by the caller if it already exists, or is free to claim if
  // it doesn't.
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
        const existingDeveloper = await this.db
          .prepare(
            "SELECT owner_user_id, ownership_epoch FROM developers WHERE id = ?"
          )
          .bind(existingExtension.author_id)
          .first<{ owner_user_id: string | null; ownership_epoch: number }>();

        if (
          !existingDeveloper ||
          existingDeveloper.owner_user_id !== callerId
        ) {
          return {
            data: null,
            error: {
              message: "You do not own the developer of this extension",
              code: "FORBIDDEN"
            }
          };
        }

        extensionId = existingExtension.id;
      }

      const payloadDeveloper = await this.db
        .prepare(
          "SELECT owner_user_id, ownership_epoch FROM developers WHERE id = ?"
        )
        .bind(payload.developer.id)
        .first<{ owner_user_id: string | null; ownership_epoch: number }>();

      if (!payloadDeveloper || payloadDeveloper.owner_user_id !== callerId) {
        return {
          data: null,
          error: {
            message:
              "You do not own this developer, or it doesn't exist yet — create a developer profile first",
            code: "FORBIDDEN"
          }
        };
      }

      return {
        data: {
          extensionId,
          developerId: payload.developer.id,
          ownershipEpoch: Number(payloadDeveloper.ownership_epoch ?? 1)
        },
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
          `INSERT INTO extension_submissions
             (id, extension_id, developer_id, submitted_by, status, payload, ownership_epoch, target_key)
           SELECT ?, ?, ?, ?, 'pending', ?, d.ownership_epoch, LOWER(?)
           FROM developers d
           WHERE d.id = ? AND d.owner_user_id = ? AND d.ownership_epoch = ?
             AND (
               SELECT COUNT(*) FROM extension_submissions
               WHERE submitted_by = ? AND status = 'pending'
             ) < ?
             AND (
               (? IS NULL AND NOT EXISTS (
                 SELECT 1 FROM extensions WHERE LOWER(id) = LOWER(?)
               ))
               OR
               (? IS NOT NULL AND EXISTS (
                 SELECT 1 FROM extensions
                 WHERE id = ? AND author_id = d.id
               ))
             )`
        )
        .bind(
          id,
          input.extensionId,
          input.developerId,
          input.submittedBy,
          JSON.stringify(input.payload),
          input.payload.extension.id,
          input.developerId,
          input.submittedBy,
          input.ownershipEpoch,
          input.submittedBy,
          MAX_PENDING_SUBMISSIONS_PER_USER,
          input.extensionId,
          input.payload.extension.id,
          input.extensionId,
          input.extensionId
        )
        .run();
    } catch (error) {
      if (isPendingTargetConflict(error)) {
        return {
          data: null,
          error: {
            message: "A submission for this extension is already pending",
            code: "CONFLICT"
          }
        };
      }
      return databaseError("create", error);
    }

    if (!result.success) {
      return databaseError(
        "create",
        new Error(result.error || "Database query failed")
      );
    }

    if (!result.meta?.changes) {
      return {
        data: null,
        error: {
          message:
            "Submission could not be created because ownership changed, the target changed, or the pending-submission limit was reached",
          code: "CONFLICT"
        }
      };
    }

    return { data: { id }, error: null };
  }

  async listBySubmitter(
    userId: string,
    limit: number,
    cursor?: string
  ): Promise<DatabaseResult<SubmissionPage>> {
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      return {
        data: null,
        error: { message: "Invalid pagination cursor", code: "INVALID_CURSOR" }
      };
    }
    let result;
    try {
      const statement = decoded
        ? this.db
            .prepare(
              `SELECT * FROM extension_submissions
               WHERE submitted_by = ?
                 AND (created_at < ? OR (created_at = ? AND id < ?))
               ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .bind(userId, decoded[0], decoded[0], decoded[1], limit + 1)
        : this.db
            .prepare(
              `SELECT * FROM extension_submissions
               WHERE submitted_by = ?
               ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .bind(userId, limit + 1);
      result = await statement.all<Record<string, unknown>>();
    } catch (error) {
      return databaseError("listBySubmitter", error);
    }

    if (!result.success) {
      return databaseError(
        "listBySubmitter",
        new Error(result.error || "Database query failed")
      );
    }

    const rows = result.results ?? [];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(parseSubmissionRow);
    const last = items.at(-1);
    return {
      data: {
        items,
        hasMore,
        nextCursor:
          hasMore && last ? encodeCursor(last.created_at, last.id) : null
      },
      error: null
    };
  }

  async listQueue(
    status: SubmissionStatus,
    limit: number,
    cursor?: string
  ): Promise<DatabaseResult<SubmissionPage>> {
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      return {
        data: null,
        error: { message: "Invalid pagination cursor", code: "INVALID_CURSOR" }
      };
    }
    let result;
    try {
      const statement = decoded
        ? this.db
            .prepare(
              `SELECT * FROM extension_submissions
               WHERE status = ?
                 AND (created_at > ? OR (created_at = ? AND id > ?))
               ORDER BY created_at ASC, id ASC LIMIT ?`
            )
            .bind(status, decoded[0], decoded[0], decoded[1], limit + 1)
        : this.db
            .prepare(
              `SELECT * FROM extension_submissions
               WHERE status = ?
               ORDER BY created_at ASC, id ASC LIMIT ?`
            )
            .bind(status, limit + 1);
      result = await statement.all<Record<string, unknown>>();
    } catch (error) {
      return databaseError("listQueue", error);
    }

    if (!result.success) {
      return databaseError(
        "listQueue",
        new Error(result.error || "Database query failed")
      );
    }

    const rows = result.results ?? [];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(parseSubmissionRow);
    const last = items.at(-1);
    return {
      data: {
        items,
        hasMore,
        nextCursor:
          hasMore && last ? encodeCursor(last.created_at, last.id) : null
      },
      error: null
    };
  }

  async getById(id: string): Promise<DatabaseResult<StoredSubmission>> {
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

    if (!this.db.batch) {
      return databaseError(
        "approve",
        new Error("Database adapter does not support batch operations")
      );
    }

    const { developer, extension } = submission.payload;
    const extensionId = submission.extension_id ?? extension.id;

    let results;
    try {
      // D1 executes a batch as one transaction. The first statement binds
      // the moderation transition to the submitter's captured ownership
      // epoch; transfer and approval therefore cannot interleave.
      const claimStmt = this.db
        .prepare(
          `UPDATE extension_submissions
           SET status = 'approved', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'pending'
             AND EXISTS (
               SELECT 1 FROM developers d
               WHERE d.id = extension_submissions.developer_id
                 AND d.owner_user_id = extension_submissions.submitted_by
                 AND d.ownership_epoch = extension_submissions.ownership_epoch
             )
             AND (
               (extension_id IS NULL AND NOT EXISTS (
                 SELECT 1 FROM extensions e
                 WHERE LOWER(e.id) = LOWER(?)
               ))
               OR
               (extension_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM extensions e
                 WHERE e.id = extension_submissions.extension_id
                   AND e.author_id = extension_submissions.developer_id
               ))
             )`
        )
        .bind(reviewerId, reviewNote ?? null, id, extension.id);

      const developerStmt = this.db
        .prepare(
          `UPDATE developers
           SET type = ?, name = ?, url = ?,
               content_revision = content_revision + 1,
               approved_at = NULL, approved_revision = NULL, approved_by = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE changes() = 1 AND id = ? AND owner_user_id = ?
             AND ownership_epoch = ?`
        )
        .bind(
          developer.type,
          developer.name,
          developer.URL ?? null,
          developer.id,
          submission.submitted_by,
          submission.ownershipEpoch
        );

      const extensionStmt = this.db
        .prepare(
          `INSERT INTO extensions (id, type, author_id, name, description, releases, website, license, icon_url, readme, source, version, download_url)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE changes() = 1
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
          developer.id,
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

      results = (await this.db.batch([
        claimStmt,
        developerStmt,
        extensionStmt
      ])) as Array<{
        success: boolean;
        error?: string;
        meta?: { changes?: number };
      }>;
    } catch (error) {
      return databaseError("approve", error);
    }

    const failed = results.find((r) => !r.success);
    if (failed) {
      return databaseError(
        "approve",
        new Error(failed.error || "Database write failed")
      );
    }

    if (!results[0]?.meta?.changes) {
      return {
        data: null,
        error: {
          message:
            "Submission is not pending, ownership changed, or the extension target changed",
          code: "CONFLICT"
        }
      };
    }

    return { data: { id, status: "approved" }, error: null };
  }
}
