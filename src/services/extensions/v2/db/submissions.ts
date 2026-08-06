import { and, asc, desc, eq, gt, lt, or, sql, SQL } from "drizzle-orm";
import { DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { extensionSubmissions, developers, extensions, users } from "./schema";
import { databaseError } from "./errors";
import { toD1Statement } from "./batch";
import { encodeCursor as encode, decodeCursor as decode } from "./cursor";
import { isReservedExtensionId } from "../schemas/extensions";
import {
  Submission,
  SubmissionPayload,
  SubmissionStatus
} from "../schemas/submissions";

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

interface SubmissionCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(createdAt: string, id: string): string {
  return encode({ createdAt, id });
}

function isSubmissionCursor(
  parsed: Record<string, unknown>
): parsed is SubmissionCursor & Record<string, unknown> {
  return typeof parsed.createdAt === "string" && typeof parsed.id === "string";
}

function decodeCursor(cursor: string): SubmissionCursor | null {
  return decode(cursor, isSubmissionCursor);
}

interface SubmissionRow {
  id: string;
  extensionId: string | null;
  developerId: string;
  submittedBy: string;
  status: string;
  payload: string;
  reviewerId: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  ownershipEpoch: number;
}

function parseSubmissionRow(row: SubmissionRow): StoredSubmission {
  const submission = {
    id: row.id,
    extension_id: row.extensionId,
    developer_id: row.developerId,
    submitted_by: row.submittedBy,
    status: row.status as SubmissionStatus,
    payload: JSON.parse(row.payload) as SubmissionPayload,
    reviewer_id: row.reviewerId,
    review_note: row.reviewNote,
    created_at: row.createdAt,
    reviewed_at: row.reviewedAt
  } as StoredSubmission;
  Object.defineProperty(submission, "ownershipEpoch", {
    value: Number(row.ownershipEpoch ?? 1),
    enumerable: false
  });
  return submission;
}

const SUBMISSION_COLUMNS = {
  id: extensionSubmissions.id,
  extensionId: extensionSubmissions.extensionId,
  developerId: extensionSubmissions.developerId,
  submittedBy: extensionSubmissions.submittedBy,
  status: extensionSubmissions.status,
  payload: extensionSubmissions.payload,
  reviewerId: extensionSubmissions.reviewerId,
  reviewNote: extensionSubmissions.reviewNote,
  createdAt: extensionSubmissions.createdAt,
  reviewedAt: extensionSubmissions.reviewedAt,
  ownershipEpoch: extensionSubmissions.ownershipEpoch
};

export class SubmissionsDatabase {
  constructor(private db: ExtensionsDb) {}

  // Edits require owning the extension's current developer; the developer
  // named in the payload (create, or an edit naming a different developer)
  // must be owned by the caller if it already exists, or is free to claim if
  // it doesn't.
  async resolveOwnership(
    payload: SubmissionPayload,
    callerId: string
  ): Promise<DatabaseResult<OwnershipResolution>> {
    try {
      const [existingExtension] = await this.db
        .select({ id: extensions.id, authorId: extensions.authorId })
        .from(extensions)
        .where(sql`LOWER(${extensions.id}) = LOWER(${payload.extension.id})`);

      let extensionId: string | null = null;

      if (existingExtension) {
        const [existingDeveloper] = await this.db
          .select({
            ownerUserId: developers.ownerUserId,
            ownershipEpoch: developers.ownershipEpoch
          })
          .from(developers)
          .where(eq(developers.id, existingExtension.authorId));

        if (!existingDeveloper || existingDeveloper.ownerUserId !== callerId) {
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

      const [payloadDeveloper] = await this.db
        .select({
          ownerUserId: developers.ownerUserId,
          ownershipEpoch: developers.ownershipEpoch
        })
        .from(developers)
        .where(eq(developers.id, payload.developer.id));

      if (!payloadDeveloper || payloadDeveloper.ownerUserId !== callerId) {
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
          ownershipEpoch: Number(payloadDeveloper.ownershipEpoch ?? 1)
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
      result = await this.db.run(sql`
        INSERT INTO ${extensionSubmissions}
             (id, extension_id, developer_id, submitted_by, status, payload, ownership_epoch, target_key)
           SELECT ${id}, ${input.extensionId}, ${input.developerId}, ${input.submittedBy}, 'pending', ${JSON.stringify(input.payload)}, d.ownership_epoch, LOWER(${input.payload.extension.id})
           FROM ${developers} d
           WHERE d.id = ${input.developerId} AND d.owner_user_id = ${input.submittedBy} AND d.ownership_epoch = ${input.ownershipEpoch}
             AND EXISTS (
               SELECT 1 FROM ${users} u
               WHERE u.id = ${input.submittedBy} AND u.deleted_at IS NULL
             )
             AND (
               SELECT COUNT(*) FROM ${extensionSubmissions}
               WHERE submitted_by = ${input.submittedBy} AND status = 'pending'
             ) < ${MAX_PENDING_SUBMISSIONS_PER_USER}
             AND (
               (${input.extensionId} IS NULL AND NOT EXISTS (
                 SELECT 1 FROM ${extensions} WHERE LOWER(id) = LOWER(${input.payload.extension.id})
               ))
               OR
               (${input.extensionId} IS NOT NULL AND EXISTS (
                 SELECT 1 FROM ${extensions}
                 WHERE id = ${input.extensionId} AND author_id = d.id
               ))
             )
        ON CONFLICT DO NOTHING
      `);
    } catch (error) {
      return databaseError("create", error);
    }

    if (!result.meta?.changes) {
      return { data: null, error: await this.createBlockedError(input) };
    }

    return { data: { id }, error: null };
  }

  // The insert affected no rows, which means either its WHERE guard rejected
  // the caller or ON CONFLICT DO NOTHING swallowed a collision with the
  // pending-target unique index. Only the second case has a specific message,
  // so look for the row that would have caused it; anything else falls back to
  // the combined guard explanation. Replaces regex-matching the driver's
  // "UNIQUE constraint failed" text, which silently coupled this branch to the
  // index name in db/schema.ts.
  private async createBlockedError(
    input: CreateInput
  ): Promise<{ message: string; code: string }> {
    const targetKey = input.payload.extension.id.toLowerCase();
    try {
      const [pending] = await this.db
        .select({ one: sql`1` })
        .from(extensionSubmissions)
        .where(
          and(
            eq(extensionSubmissions.targetKey, targetKey),
            eq(extensionSubmissions.status, "pending")
          )
        );
      if (pending) {
        return {
          message: "A submission for this extension is already pending",
          code: "CONFLICT"
        };
      }
    } catch {
      // Fall through to the generic explanation - this path is only ever
      // refining an error message that is already being returned.
    }

    return {
      message:
        "Submission could not be created because ownership changed, the target changed, or the pending-submission limit was reached",
      code: "CONFLICT"
    };
  }

  // listBySubmitter and listQueue are the same keyset page in opposite
  // directions: newest-first for a submitter reviewing their own history,
  // oldest-first for moderators working a queue front to back. Only the base
  // predicate and the direction differ, so the cursor handling, the tie-break
  // on id, the limit + 1 probe and the next-cursor tail live here once.
  private async page(
    context: string,
    baseCondition: SQL,
    direction: "asc" | "desc",
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

    const [beyond, order] =
      direction === "desc" ? [lt, desc] : ([gt, asc] as const);

    let rows: SubmissionRow[];
    try {
      const conditions = [baseCondition];
      if (decoded) {
        const { createdAt, id: cursorId } = decoded;
        conditions.push(
          or(
            beyond(extensionSubmissions.createdAt, createdAt),
            and(
              eq(extensionSubmissions.createdAt, createdAt),
              beyond(extensionSubmissions.id, cursorId)
            )
          )!
        );
      }
      rows = await this.db
        .select(SUBMISSION_COLUMNS)
        .from(extensionSubmissions)
        .where(and(...conditions))
        .orderBy(
          order(extensionSubmissions.createdAt),
          order(extensionSubmissions.id)
        )
        .limit(limit + 1);
    } catch (error) {
      return databaseError(context, error);
    }

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

  async listBySubmitter(
    userId: string,
    limit: number,
    cursor?: string
  ): Promise<DatabaseResult<SubmissionPage>> {
    return this.page(
      "listBySubmitter",
      eq(extensionSubmissions.submittedBy, userId),
      "desc",
      limit,
      cursor
    );
  }

  async listQueue(
    status: SubmissionStatus,
    limit: number,
    cursor?: string
  ): Promise<DatabaseResult<SubmissionPage>> {
    return this.page(
      "listQueue",
      eq(extensionSubmissions.status, status),
      "asc",
      limit,
      cursor
    );
  }

  async getById(id: string): Promise<DatabaseResult<StoredSubmission>> {
    let row: SubmissionRow | undefined;
    try {
      [row] = await this.db
        .select(SUBMISSION_COLUMNS)
        .from(extensionSubmissions)
        .where(eq(extensionSubmissions.id, id));
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
        .update(extensionSubmissions)
        .set({
          status: "rejected",
          reviewerId,
          reviewNote,
          reviewedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(extensionSubmissions.id, id),
            eq(extensionSubmissions.status, "pending"),
            sql`EXISTS (
              SELECT 1 FROM ${users}
              WHERE ${users.id} = ${reviewerId} AND ${users.deletedAt} IS NULL
            )`
          )
        );
    } catch (error) {
      return databaseError("reject", error);
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

    const { developer, extension } = submission.payload;
    const extensionId = submission.extension_id ?? extension.id;

    // Stored submissions predate the reserved-id validation on new requests,
    // so re-check the payload at the approval boundary before it can be
    // written through to the public catalogue.
    if (
      isReservedExtensionId(extension.id) ||
      isReservedExtensionId(extensionId)
    ) {
      return {
        data: null,
        error: {
          message: "This extension id is reserved",
          code: "CONFLICT"
        }
      };
    }

    // Kept as raw sql via the raw D1 client (see toD1Statement) rather than
    // the query builder: D1's batch() executes these three statements as
    // one transaction, and the developer/extension statements are
    // deliberately gated on `changes() = 1` from the immediately-preceding
    // statement (SQLite's per-connection changes() function) so a race or
    // ownership/target change caught by the first statement's WHERE also
    // blocks the other two - a guarantee that's easy to silently lose by
    // rewriting this as three independent query-builder calls. Also works
    // around a drizzle-orm 0.45.2 bug where db.run(sql) with bound params
    // can't be used inside db.batch() at all (confirmed via an isolated
    // repro against real D1).
    let results;
    try {
      const claimStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE extension_submissions
              SET status = 'approved', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'pending'
                AND EXISTS (
                  SELECT 1 FROM developers d
                  WHERE d.id = extension_submissions.developer_id
                    AND d.owner_user_id = extension_submissions.submitted_by
                    AND d.ownership_epoch = extension_submissions.ownership_epoch
                )
                AND EXISTS (
                  SELECT 1 FROM users u
                  WHERE u.id = ? AND u.deleted_at IS NULL
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
                )`,
        params: [reviewerId, reviewNote ?? null, id, reviewerId, extension.id]
      });

      const developerStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE developers
              SET type = ?, name = ?, url = ?,
                  content_revision = content_revision + 1,
                  approved_at = NULL, approved_revision = NULL, approved_by = NULL,
                  updated_at = CURRENT_TIMESTAMP
              WHERE changes() = 1 AND id = ? AND owner_user_id = ?
                AND ownership_epoch = ?`,
        params: [
          developer.type,
          developer.name,
          developer.URL ?? null,
          developer.id,
          submission.submitted_by,
          submission.ownershipEpoch
        ]
      });

      const extensionStmt = toD1Statement(this.db.$client, {
        sql: `INSERT INTO extensions (id, type, author_id, name, description, releases, website, license, icon_url, readme, source, version, download_url)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE changes() = 1
              ON CONFLICT(id) DO UPDATE SET
                type = excluded.type, author_id = excluded.author_id, name = excluded.name,
                description = excluded.description, releases = excluded.releases,
                website = excluded.website, license = excluded.license,
                icon_url = excluded.icon_url, readme = excluded.readme,
                source = excluded.source, version = excluded.version,
                download_url = excluded.download_url`,
        params: [
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
        ]
      });

      results = await this.db.$client.batch([
        claimStmt,
        developerStmt,
        extensionStmt
      ]);
    } catch (error) {
      return databaseError("approve", error);
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
