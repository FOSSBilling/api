import { and, asc, desc, eq, gt, lt, or, sql, SQL } from "drizzle-orm";
import { DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { extensionRevisions, developers, extensions, users } from "./schema";
import { databaseError } from "./errors";
import { toD1Statement } from "./batch";
import { encodeCursor as encode, decodeCursor as decode } from "./cursor";
import { MAX_PENDING_REVISIONS_PER_USER, parseContent } from "./extensions";
import { ExtensionContent } from "../schemas/extensions";
import { ExtensionRevision, RevisionStatus } from "../schemas/revisions";

export interface RevisionPage {
  items: ExtensionRevision[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface StoredRevision extends ExtensionRevision {
  ownershipEpoch: number;
}

interface RevisionCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(createdAt: string, id: string): string {
  return encode({ createdAt, id });
}

function isRevisionCursor(
  parsed: Record<string, unknown>
): parsed is RevisionCursor & Record<string, unknown> {
  return typeof parsed.createdAt === "string" && typeof parsed.id === "string";
}

function decodeCursor(cursor: string): RevisionCursor | null {
  return decode(cursor, isRevisionCursor);
}

interface RevisionRow {
  id: string;
  extensionId: string;
  developerId: string;
  submittedBy: string;
  status: string;
  content: string;
  reviewerId: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  ownershipEpoch: number;
}

function parseRevisionRow(row: RevisionRow): StoredRevision {
  const revision = {
    id: row.id,
    extension_id: row.extensionId,
    developer_id: row.developerId,
    submitted_by: row.submittedBy,
    status: row.status as RevisionStatus,
    content: parseContent(row.content),
    reviewer_id: row.reviewerId,
    review_note: row.reviewNote,
    created_at: row.createdAt,
    reviewed_at: row.reviewedAt
  } as StoredRevision;
  Object.defineProperty(revision, "ownershipEpoch", {
    value: Number(row.ownershipEpoch ?? 1),
    enumerable: false
  });
  return revision;
}

const REVISION_COLUMNS = {
  id: extensionRevisions.id,
  extensionId: extensionRevisions.extensionId,
  developerId: extensionRevisions.developerId,
  submittedBy: extensionRevisions.submittedBy,
  status: extensionRevisions.status,
  content: extensionRevisions.content,
  reviewerId: extensionRevisions.reviewerId,
  reviewNote: extensionRevisions.reviewNote,
  createdAt: extensionRevisions.createdAt,
  reviewedAt: extensionRevisions.reviewedAt,
  ownershipEpoch: extensionRevisions.ownershipEpoch
};

export class ExtensionRevisionsDatabase {
  constructor(private db: ExtensionsDb) {}

  // Proposes an edit to an existing extension. Ownership is resolved inside
  // the insert rather than by a preceding SELECT: the extension names its
  // developer and the developer names its owner, so one statement can assert
  // "the caller still owns this extension" atomically with the write.
  async propose(input: {
    extensionId: string;
    callerId: string;
    content: ExtensionContent;
  }): Promise<DatabaseResult<{ id: string }>> {
    const id = crypto.randomUUID();

    let result;
    try {
      result = await this.db.run(sql`
        INSERT INTO ${extensionRevisions}
             (id, extension_id, developer_id, submitted_by, status, content, ownership_epoch)
           SELECT ${id}, e.id, d.id, ${input.callerId}, 'pending', ${JSON.stringify(input.content)}, d.ownership_epoch
           FROM ${extensions} e
           JOIN ${developers} d ON d.id = e.developer_id
           WHERE LOWER(e.id) = LOWER(${input.extensionId})
             AND d.owner_user_id = ${input.callerId}
             AND EXISTS (
               SELECT 1 FROM ${users} u
               WHERE u.id = ${input.callerId} AND u.deleted_at IS NULL
             )
             AND (
               SELECT COUNT(*) FROM ${extensionRevisions}
               WHERE submitted_by = ${input.callerId} AND status = 'pending'
             ) < ${MAX_PENDING_REVISIONS_PER_USER}
        ON CONFLICT DO NOTHING
      `);
    } catch (error) {
      return databaseError("propose", error);
    }

    if (!result.meta?.changes) {
      try {
        return { data: null, error: await this.proposeBlockedError(input) };
      } catch (error) {
        return databaseError("propose", error);
      }
    }

    return { data: { id }, error: null };
  }

  // Distinguishes the three ways the guard above can reject a write, so the
  // route can map them to 404/403/409 rather than one opaque conflict.
  private async proposeBlockedError(input: {
    extensionId: string;
    callerId: string;
  }): Promise<{ message: string; code: string }> {
    const [existing] = await this.db
      .select({ ownerUserId: developers.ownerUserId })
      .from(extensions)
      .innerJoin(developers, eq(extensions.developerId, developers.id))
      .where(sql`LOWER(${extensions.id}) = LOWER(${input.extensionId})`);

    if (!existing) {
      return {
        message: `Cannot find extension by id: ${input.extensionId}`,
        code: "NOT_FOUND"
      };
    }
    if (existing.ownerUserId !== input.callerId) {
      return {
        message: "You do not own this extension",
        code: "FORBIDDEN"
      };
    }

    const [pending] = await this.db
      .select({ one: sql`1` })
      .from(extensionRevisions)
      .where(
        and(
          sql`LOWER(${extensionRevisions.extensionId}) = LOWER(${input.extensionId})`,
          eq(extensionRevisions.status, "pending")
        )
      );
    if (pending) {
      return {
        message: "An edit to this extension is already awaiting review",
        code: "CONFLICT"
      };
    }

    return {
      message: "The pending-revision limit was reached",
      code: "CONFLICT"
    };
  }

  // listByExtension and listQueue are the same keyset page in opposite
  // directions: newest-first for an owner reading an extension's history,
  // oldest-first for moderators working a queue front to back. Only the base
  // predicate and the direction differ, so the cursor handling, the tie-break
  // on id, the limit + 1 probe and the next-cursor tail live here once.
  private async page(
    context: string,
    baseCondition: SQL,
    direction: "asc" | "desc",
    limit: number,
    cursor?: string
  ): Promise<DatabaseResult<RevisionPage>> {
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) {
      return {
        data: null,
        error: { message: "Invalid pagination cursor", code: "INVALID_CURSOR" }
      };
    }

    const [beyond, order] =
      direction === "desc" ? [lt, desc] : ([gt, asc] as const);

    let rows: RevisionRow[];
    try {
      const conditions = [baseCondition];
      if (decoded) {
        const { createdAt, id: cursorId } = decoded;
        conditions.push(
          or(
            beyond(extensionRevisions.createdAt, createdAt),
            and(
              eq(extensionRevisions.createdAt, createdAt),
              beyond(extensionRevisions.id, cursorId)
            )
          )!
        );
      }
      rows = await this.db
        .select(REVISION_COLUMNS)
        .from(extensionRevisions)
        .where(and(...conditions))
        .orderBy(
          order(extensionRevisions.createdAt),
          order(extensionRevisions.id)
        )
        .limit(limit + 1);
    } catch (error) {
      return databaseError(context, error);
    }

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(parseRevisionRow);
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

  async listByExtension(
    extensionId: string,
    limit: number,
    cursor?: string
  ): Promise<DatabaseResult<RevisionPage>> {
    return this.page(
      "listByExtension",
      eq(extensionRevisions.extensionId, extensionId),
      "desc",
      limit,
      cursor
    );
  }

  async listQueue(
    status: RevisionStatus,
    limit: number,
    cursor?: string
  ): Promise<DatabaseResult<RevisionPage>> {
    return this.page(
      "listQueue",
      eq(extensionRevisions.status, status),
      "asc",
      limit,
      cursor
    );
  }

  async getById(
    extensionId: string,
    id: string
  ): Promise<DatabaseResult<StoredRevision>> {
    let row: RevisionRow | undefined;
    try {
      [row] = await this.db
        .select(REVISION_COLUMNS)
        .from(extensionRevisions)
        .where(
          and(
            eq(extensionRevisions.id, id),
            sql`LOWER(${extensionRevisions.extensionId}) = LOWER(${extensionId})`
          )
        );
    } catch (error) {
      return databaseError("getById", error);
    }

    if (!row) return revisionNotFound(id);
    return { data: parseRevisionRow(row), error: null };
  }

  // Notes what happened to an id-scoped write that didn't affect any rows:
  // either it never existed, or someone else already moved it off 'pending'.
  private async explainNoOpTransition(
    extensionId: string,
    id: string
  ): Promise<DatabaseResult<never>> {
    const existing = await this.getById(extensionId, id);
    if (existing.error || !existing.data) {
      return {
        data: null,
        error: existing.error ?? revisionNotFound(id).error
      };
    }
    return {
      data: null,
      error: { message: "Revision is not pending", code: "CONFLICT" }
    };
  }

  // The `AND status = 'pending'` guard makes this a single atomic
  // check-and-set: if two moderators race, only one's update affects a row.
  async reject(
    extensionId: string,
    id: string,
    reviewerId: string,
    reviewNote: string
  ): Promise<DatabaseResult<{ id: string; status: "rejected" }>> {
    let result;
    try {
      result = await this.db
        .update(extensionRevisions)
        .set({
          status: "rejected",
          reviewerId,
          reviewNote,
          reviewedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            eq(extensionRevisions.id, id),
            sql`LOWER(${extensionRevisions.extensionId}) = LOWER(${extensionId})`,
            eq(extensionRevisions.status, "pending"),
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
      return this.explainNoOpTransition(extensionId, id);
    }

    return { data: { id, status: "rejected" }, error: null };
  }

  // Approving publishes the revision's content into the extension row. Unlike
  // the pre-0021 flow this touches nothing else: the developer profile is not
  // rewritten, and the extension's id and author are not up for review because
  // a revision cannot propose them.
  async approve(
    extensionId: string,
    id: string,
    reviewerId: string,
    reviewNote?: string
  ): Promise<DatabaseResult<{ id: string; status: "approved" }>> {
    const existing = await this.getById(extensionId, id);
    if (existing.error || !existing.data) {
      return {
        data: null,
        error: existing.error ?? revisionNotFound(id).error
      };
    }
    const revision = existing.data;

    if (revision.status !== "pending") {
      return {
        data: null,
        error: { message: "Revision is not pending", code: "CONFLICT" }
      };
    }

    const content = revision.content;

    // Kept as raw sql via the raw D1 client (see toD1Statement) rather than
    // the query builder: D1's batch() executes these two statements as one
    // transaction, and the publish is deliberately gated on `changes() = 1`
    // from the immediately-preceding statement (SQLite's per-connection
    // changes() function) so a race or ownership change caught by the claim's
    // WHERE also blocks the publish - a guarantee that's easy to silently
    // lose by rewriting this as two independent query-builder calls.
    let results;
    try {
      const claimStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE extension_revisions
              SET status = 'approved', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP
              WHERE id = ? AND extension_id = ? AND status = 'pending'
                AND EXISTS (
                  SELECT 1 FROM extensions e
                  JOIN developers d ON d.id = e.developer_id
                  WHERE e.id = extension_revisions.extension_id
                    AND d.id = extension_revisions.developer_id
                    AND d.owner_user_id = extension_revisions.submitted_by
                    AND d.ownership_epoch = extension_revisions.ownership_epoch
                )
                AND EXISTS (
                  SELECT 1 FROM users u
                  WHERE u.id = ? AND u.deleted_at IS NULL
                )`,
        params: [
          reviewerId,
          reviewNote ?? null,
          id,
          revision.extension_id,
          reviewerId
        ]
      });

      // published_at is COALESCEd rather than overwritten: it records when the
      // extension first entered the catalogue, and updated_at carries the
      // "changed just now" signal.
      const publishStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE extensions
              SET type = ?, name = ?, description = ?, releases = ?, website = ?,
                  license = ?, icon_url = ?, readme = ?, source = ?, version = ?,
                  download_url = ?,
                  published_at = COALESCE(published_at, CURRENT_TIMESTAMP),
                  published_revision_id = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE changes() = 1 AND id = ?`,
        params: [
          content.type,
          content.name,
          content.description,
          JSON.stringify(content.releases),
          content.website,
          JSON.stringify(content.license),
          content.icon_url ?? null,
          content.readme,
          JSON.stringify(content.source),
          content.version,
          content.download_url,
          id,
          revision.extension_id
        ]
      });

      results = await this.db.$client.batch([claimStmt, publishStmt]);
    } catch (error) {
      return databaseError("approve", error);
    }

    if (!results[0]?.meta?.changes) {
      return {
        data: null,
        error: {
          message:
            "Revision is not pending, or ownership changed since it was proposed",
          code: "CONFLICT"
        }
      };
    }

    return { data: { id, status: "approved" }, error: null };
  }
}

function revisionNotFound(id: string): DatabaseResult<never> {
  return {
    data: null,
    error: { message: `Cannot find revision by id: ${id}`, code: "NOT_FOUND" }
  };
}
