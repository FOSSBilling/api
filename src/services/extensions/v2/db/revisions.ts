import { packageIconUrl } from "./packages";
import { validatePackageContent } from "./packages";
import { manifestMetadata } from "../schemas/manifest";
import { MAX_CONTENT_BYTES } from "../resource-limits";
import { and, asc, desc, eq, gt, lt, or, sql, SQL } from "drizzle-orm";
import { DatabaseError, DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { extensionRevisions, developers, extensions, users } from "./schema";
import {
  databaseError,
  contentAdmissionError,
  inactiveActorError,
  moderatorActorError
} from "./errors";
import { toD1Statement } from "./batch";
import { createCursorCodec } from "./cursor";
import {
  MAX_PENDING_REVISIONS_PER_USER,
  parseContent,
  LegacyContentError,
  oversizedContent
} from "./extensions";
import {
  ExtensionContent,
  ExtensionContentSchema
} from "../schemas/extensions";
import {
  ExtensionRevision,
  ExtensionRevisionSummary,
  RevisionStatus
} from "../schemas/revisions";

export interface RevisionPage {
  items: ExtensionRevisionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface StoredRevision extends ExtensionRevision {
  ownershipEpoch: number;
}

type RevisionCursor = {
  createdAt: string;
  id: string;
};

const revisionCursor = createCursorCodec<RevisionCursor>(
  (parsed): parsed is RevisionCursor =>
    typeof parsed.createdAt === "string" && typeof parsed.id === "string"
);

interface RevisionRow {
  id: string;
  extensionId: string;
  extensionIdentifier: string;
  developerId: string;
  submittedBy: string;
  status: string;
  content: string | null;
  contentBytes: number;
  contentReadable: number;
  name: string | null;
  version: string | null;
  description: string | null;
  contentHash: string | null;
  compactedAt: string | null;
  reviewerId: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  ownershipEpoch: number;
}

function parseRevisionRow(row: RevisionRow): StoredRevision {
  const revision = {
    ...parseSummaryRow(row),
    content: row.compactedAt ? null : parseContent(row.content)
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
  extensionIdentifier: sql<string>`(SELECT identifier FROM extensions WHERE id=${extensionRevisions.extensionId})`,
  developerId: extensionRevisions.developerId,
  submittedBy: extensionRevisions.submittedBy,
  status: extensionRevisions.status,
  content: sql<
    string | null
  >`CASE WHEN length(CAST(${extensionRevisions.content} AS BLOB)) <= ${MAX_CONTENT_BYTES} THEN ${extensionRevisions.content} ELSE NULL END`,
  name: extensionRevisions.summaryName,
  version: extensionRevisions.summaryVersion,
  description: extensionRevisions.summaryDescription,
  contentBytes: extensionRevisions.contentBytes,
  contentReadable: extensionRevisions.contentReadable,
  contentHash: extensionRevisions.contentHash,
  compactedAt: extensionRevisions.compactedAt,
  reviewerId: extensionRevisions.reviewerId,
  reviewNote: sql<
    string | null
  >`substr(${extensionRevisions.reviewNote}, 1, 2000)`,
  createdAt: extensionRevisions.createdAt,
  reviewedAt: extensionRevisions.reviewedAt,
  ownershipEpoch: extensionRevisions.ownershipEpoch
};

const { content: _content, ...SUMMARY_COLUMNS } = REVISION_COLUMNS;
type SummaryRow = Omit<RevisionRow, "content">;
function parseSummaryRow(row: SummaryRow): ExtensionRevisionSummary {
  return {
    id: row.id,
    extension_id: row.extensionId,
    extension_identifier: row.extensionIdentifier,
    developer_id: row.developerId,
    submitted_by: row.submittedBy,
    status: row.status as RevisionStatus,
    reviewer_id: row.reviewerId,
    review_note: row.reviewNote,
    created_at: row.createdAt,
    reviewed_at: row.reviewedAt,
    name: row.name,
    version: row.version,
    description: row.description,
    content_bytes: row.contentBytes,
    content_available:
      !row.compactedAt &&
      row.contentBytes <= MAX_CONTENT_BYTES &&
      Boolean(row.contentReadable),
    content_hash: row.contentHash,
    compacted_at: row.compactedAt
  };
}

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
      const packageError = await validatePackageContent(
        this.db.$client,
        input.extensionId,
        undefined,
        input.content,
        input.callerId
      );
      if (packageError) return { data: null, error: packageError };
      result = await this.db.run(sql`
        INSERT INTO ${extensionRevisions}
             (id, extension_id, developer_id, submitted_by, status, content, ownership_epoch)
           SELECT ${id}, e.id, d.id, ${input.callerId}, 'pending', ${JSON.stringify(input.content)}, d.ownership_epoch
           FROM ${extensions} e
           JOIN ${developers} d ON d.id = e.developer_id
           WHERE LOWER(e.identifier) = LOWER(${input.extensionId})
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
      return contentAdmissionError("propose", error);
    }

    if (!result.meta?.changes) {
      try {
        return { data: null, error: await this.proposeBlockedError(input) };
      } catch (error) {
        return contentAdmissionError("propose", error);
      }
    }

    return { data: { id }, error: null };
  }

  // Owners can replace publisher submissions; attribute the new row to the owner.
  // A fresh ID invalidates stale edits and reviews. Both writes must be atomic
  // so admission failures keep the original pending revision.
  async replacePending(input: {
    extensionId: string;
    revisionId: string;
    callerId: string;
    content: ExtensionContent;
  }): Promise<DatabaseResult<{ id: string; identifier: string }>> {
    const id = crypto.randomUUID();
    try {
      const packageError = await validatePackageContent(
        this.db.$client,
        input.extensionId,
        undefined,
        input.content,
        input.callerId
      );
      if (packageError) return { data: null, error: packageError };
      const results = await this.db.$client.batch<{ identifier: string }>([
        this.db.$client
          .prepare(
            `
          DELETE FROM extension_revisions
          WHERE id = ? AND status = 'pending'
            AND EXISTS (
              SELECT 1 FROM extensions e JOIN developers d ON d.id = e.developer_id
              JOIN users u ON u.id = d.owner_user_id
              WHERE LOWER(e.identifier) = LOWER(?) AND e.id = extension_revisions.extension_id
                AND d.id = extension_revisions.developer_id
                AND d.ownership_epoch = extension_revisions.ownership_epoch
                AND d.owner_user_id = ? AND u.deleted_at IS NULL
            )
            AND (submitted_by = ? OR (
              SELECT COUNT(*) FROM extension_revisions WHERE submitted_by = ? AND status = 'pending'
            ) < ?)
        `
          )
          .bind(
            input.revisionId,
            input.extensionId,
            input.callerId,
            input.callerId,
            input.callerId,
            MAX_PENDING_REVISIONS_PER_USER
          ),
        this.db.$client
          .prepare(
            `
          INSERT INTO extension_revisions
            (id, extension_id, developer_id, submitted_by, status, content, ownership_epoch)
          SELECT ?, e.id, d.id, ?, 'pending', ?, d.ownership_epoch
          FROM extensions e JOIN developers d ON d.id = e.developer_id
          WHERE LOWER(e.identifier) = LOWER(?) AND changes() = 1
          RETURNING (SELECT identifier FROM extensions WHERE id=extension_id) AS identifier
        `
          )
          .bind(
            id,
            input.callerId,
            JSON.stringify(input.content),
            input.extensionId
          )
      ]);
      const [replacement] = results[1].results;
      if (replacement)
        return {
          data: {
            id,
            identifier: replacement.identifier
          },
          error: null
        };
      const error = await this.proposeBlockedError(input);
      return {
        data: null,
        error:
          error.code === "CONFLICT"
            ? {
                code: "CONFLICT",
                message:
                  "The pending submission changed, was reviewed, or the pending-revision limit was reached. Reload before editing again."
              }
            : error
      };
    } catch (error) {
      return contentAdmissionError("replacePending", error);
    }
  }

  // Distinguishes the three ways the guard above can reject a write, so the
  // route can map them to 404/403/409 rather than one opaque conflict.
  private async proposeBlockedError(input: {
    extensionId: string;
    callerId: string;
  }): Promise<DatabaseError> {
    const inactive = await inactiveActorError(this.db, input.callerId);
    if (inactive) return inactive;

    const [existing] = await this.db
      .select({ ownerUserId: developers.ownerUserId })
      .from(extensions)
      .innerJoin(developers, eq(extensions.developerId, developers.id))
      .where(
        sql`LOWER(${extensions.identifier}) = LOWER(${input.extensionId})`
      );

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
          sql`${extensionRevisions.extensionId} = (SELECT id FROM extensions WHERE lower(identifier)=lower(${input.extensionId}))`,
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

  // Proposes an edit on behalf of a registered publisher client. The client
  // is authenticated by the auth service; the mapping (checked again inside
  // the insert) is the authorization. submitted_by is the client's synthetic
  // users row, so the pending-revision budget is per client, not per human
  // owner; the human owner's account must still be active.
  async proposeAsPublisher(input: {
    extensionId: string;
    clientId: string;
    submittedBy: string;
    developerId: string;
    content: ExtensionContent;
  }): Promise<DatabaseResult<{ id: string }>> {
    const id = crypto.randomUUID();

    let result;
    try {
      const packageError = await validatePackageContent(
        this.db.$client,
        input.extensionId,
        input.developerId,
        input.content
      );
      if (packageError) return { data: null, error: packageError };
      result = await this.db.run(sql`
        INSERT INTO ${extensionRevisions}
             (id, extension_id, developer_id, submitted_by, status, content, ownership_epoch)
           SELECT ${id}, e.id, d.id, ${input.submittedBy}, 'pending', ${JSON.stringify(input.content)}, d.ownership_epoch
           FROM ${extensions} e
           JOIN ${developers} d ON d.id = e.developer_id
           WHERE LOWER(e.identifier) = LOWER(${input.extensionId})
             AND d.id = ${input.developerId}
             AND EXISTS (
               SELECT 1 FROM ${users} u
               WHERE u.id = ${input.submittedBy} AND u.deleted_at IS NULL
             )
             AND EXISTS (
               SELECT 1 FROM ${users} o
               WHERE o.id = d.owner_user_id AND o.deleted_at IS NULL
             )
             AND EXISTS (
               SELECT 1 FROM m2m_publisher_clients m
               WHERE m.client_id = ${input.clientId}
                 AND m.revoked_at IS NULL
                 AND m.developer_id = d.id
                 AND m.ownership_epoch = d.ownership_epoch
             )
             AND (
               SELECT COUNT(*) FROM ${extensionRevisions}
               WHERE submitted_by = ${input.submittedBy} AND status = 'pending'
             ) < ${MAX_PENDING_REVISIONS_PER_USER}
        ON CONFLICT DO NOTHING
      `);
    } catch (error) {
      return contentAdmissionError("proposeAsPublisher", error);
    }

    if (!result.meta?.changes) {
      try {
        return {
          data: null,
          error: await this.proposeAsPublisherBlockedError(input)
        };
      } catch (error) {
        return contentAdmissionError("proposeAsPublisher", error);
      }
    }

    return { data: { id }, error: null };
  }

  private async proposeAsPublisherBlockedError(input: {
    extensionId: string;
    clientId: string;
    submittedBy: string;
    developerId: string;
  }): Promise<DatabaseError> {
    const inactive = await inactiveActorError(this.db, input.submittedBy);
    if (inactive) return inactive;

    const [owner] = await this.db
      .select({ ownerUserId: developers.ownerUserId })
      .from(developers)
      .where(eq(developers.id, input.developerId));
    if (owner?.ownerUserId) {
      const inactive = await inactiveActorError(this.db, owner.ownerUserId);
      if (inactive) return inactive;
    }

    const [mapping] = await this.db
      .select({ one: sql`1` })
      .from(sql`m2m_publisher_clients`)
      .where(
        sql`client_id = ${input.clientId}
            AND revoked_at IS NULL
            AND developer_id = ${input.developerId}`
      );
    if (!mapping) {
      return {
        message: "Publisher client is not registered for this developer",
        code: "FORBIDDEN"
      };
    }

    const [stale] = await this.db
      .select({ one: sql`1` })
      .from(sql`m2m_publisher_clients m, developers d`)
      .where(
        sql`m.client_id = ${input.clientId}
            AND m.revoked_at IS NULL
            AND d.id = m.developer_id
            AND d.id = ${input.developerId}
            AND m.ownership_epoch != d.ownership_epoch`
      );
    if (stale) {
      return {
        message:
          "Publisher binding is stale after an ownership change; ask a moderator to re-register it",
        code: "FORBIDDEN"
      };
    }

    const [existing] = await this.db
      .select({ one: sql`1` })
      .from(extensions)
      .where(
        sql`LOWER(${extensions.identifier}) = LOWER(${input.extensionId})`
      );

    if (!existing) {
      return {
        message: `Cannot find extension by id: ${input.extensionId}`,
        code: "NOT_FOUND"
      };
    }

    const [pending] = await this.db
      .select({ one: sql`1` })
      .from(extensionRevisions)
      .where(
        and(
          sql`${extensionRevisions.extensionId} = (SELECT id FROM extensions WHERE lower(identifier)=lower(${input.extensionId}))`,
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

  // listScoped below pages through the same keyset in opposite directions:
  // newest-first for an owner reading an extension's history, oldest-first
  // for moderators working a queue front to back. Only the base predicate
  // and the direction differ, so the cursor handling, the tie-break on id,
  // the limit + 1 probe and the next-cursor tail live here once.
  private async page(
    context: string,
    baseCondition: SQL,
    direction: "asc" | "desc",
    limit: number,
    cursor?: string,
    readerId?: string,
    extensionId?: string
  ): Promise<DatabaseResult<RevisionPage>> {
    const decoded = cursor ? revisionCursor.decode(cursor) : null;
    if (cursor && !decoded) {
      return {
        data: null,
        error: { message: "Invalid pagination cursor", code: "INVALID_CURSOR" }
      };
    }

    const [beyond, order] =
      direction === "desc" ? [lt, desc] : ([gt, asc] as const);

    let rows: SummaryRow[];
    try {
      const conditions = [baseCondition];
      if (readerId)
        conditions.push(sql`EXISTS (
        SELECT 1 FROM users u WHERE u.id=${readerId} AND u.deleted_at IS NULL
          AND (u.is_moderator=1 OR (${extensionId ?? null} IS NOT NULL AND EXISTS (
            SELECT 1 FROM extensions e JOIN developers d ON d.id=e.developer_id
            WHERE lower(e.identifier)=lower(${extensionId ?? null}) AND d.owner_user_id=${readerId}
          )))
      )`);
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
        .select(SUMMARY_COLUMNS)
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
    const items = rows.slice(0, limit).map(parseSummaryRow);
    const last = items.at(-1);
    return {
      data: {
        items,
        hasMore,
        nextCursor:
          hasMore && last
            ? revisionCursor.encode({ createdAt: last.created_at, id: last.id })
            : null
      },
      error: null
    };
  }

  // Unified reader for the merged GET /revisions. extensionId set:
  // per-extension history (caller already authorised as owner-or-moderator),
  // default newest first. Unset: global queue (moderator only), default oldest
  // first. An explicit sort overrides either default; status optionally
  // narrows both modes.
  async listScoped(filters: {
    extensionId?: string;
    readerId?: string;
    status?: RevisionStatus;
    sort?: "newest" | "oldest";
    limit?: number;
    cursor?: string;
  }): Promise<DatabaseResult<RevisionPage>> {
    const limit = filters.limit ?? 50;
    const direction =
      filters.sort === "newest"
        ? "desc"
        : filters.sort === "oldest"
          ? "asc"
          : filters.extensionId
            ? "desc"
            : "asc";
    const conditions: SQL[] = [];
    if (filters.extensionId) {
      conditions.push(
        sql`${extensionRevisions.extensionId} = (SELECT id FROM extensions WHERE lower(identifier)=lower(${filters.extensionId}))`
      );
    }
    if (filters.status) {
      conditions.push(eq(extensionRevisions.status, filters.status));
    }
    const base: SQL =
      conditions.length > 1
        ? and(...conditions)!
        : (conditions[0] ?? sql`1 = 1`);
    return this.page(
      "listScoped",
      base,
      direction,
      limit,
      filters.cursor,
      filters.readerId,
      filters.extensionId
    );
  }

  // Queue totals for the admin tabs: one GROUP BY rather than a COUNT per
  // status, so the revision queue's three badges cost a single query.
  // Unknown statuses are ignored rather than surfaced — the status column
  // is constrained at write time, so anything else would be corruption, not
  // a fourth queue.
  async countByStatus(): Promise<
    DatabaseResult<{ pending: number; approved: number; rejected: number }>
  > {
    let rows: Array<{ status: string; total: number }>;
    try {
      rows = await this.db
        .select({
          status: extensionRevisions.status,
          total: sql<number>`COUNT(*)`
        })
        .from(extensionRevisions)
        .groupBy(extensionRevisions.status);
    } catch (error) {
      return databaseError("countByStatus", error);
    }
    const totals = { pending: 0, approved: 0, rejected: 0 };
    for (const row of rows) {
      if (
        row.status === "pending" ||
        row.status === "approved" ||
        row.status === "rejected"
      ) {
        totals[row.status] = row.total;
      }
    }
    return { data: totals, error: null };
  }

  async getById(
    extensionId: string,
    id: string,
    readerId?: string
  ): Promise<DatabaseResult<StoredRevision>> {
    let row: RevisionRow | undefined;
    try {
      [row] = await this.db
        .select(REVISION_COLUMNS)
        .from(extensionRevisions)
        .where(
          and(
            eq(extensionRevisions.id, id),
            sql`${extensionRevisions.extensionId} = (SELECT id FROM extensions WHERE lower(identifier)=lower(${extensionId}))`,
            readerId
              ? sql`EXISTS (
              SELECT 1 FROM users u WHERE u.id=${readerId} AND u.deleted_at IS NULL
                AND (u.is_moderator=1 OR EXISTS (
                  SELECT 1 FROM extensions e JOIN developers d ON d.id=e.developer_id
                  WHERE e.id=extension_revisions.extension_id AND d.owner_user_id=${readerId}
                ))
            )`
              : undefined
          )
        );
    } catch (error) {
      return databaseError("getById", error);
    }

    if (!row) return revisionNotFound(id);
    if (!row.compactedAt && !row.contentReadable) return oversizedContent();
    if (row.contentBytes > MAX_CONTENT_BYTES)
      return {
        data: null,
        error: {
          code: "CONTENT_UNAVAILABLE",
          message:
            "Legacy revision exceeds the content limit; resubmit or export it administratively"
        }
      };
    try {
      return { data: parseRevisionRow(row), error: null };
    } catch (error) {
      if (error instanceof LegacyContentError) return oversizedContent();
      return databaseError("getById", error);
    }
  }

  // Notes what happened to an id-scoped write that didn't affect any rows:
  // either it never existed, or someone else already moved it off 'pending'.
  private async explainNoOpTransition(
    extensionId: string,
    id: string,
    reviewerId: string
  ): Promise<DatabaseResult<never>> {
    const actorError = await moderatorActorError(this.db, reviewerId);
    if (actorError) return { data: null, error: actorError };

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
            sql`${extensionRevisions.extensionId} = (SELECT id FROM extensions WHERE lower(identifier)=lower(${extensionId}))`,
            eq(extensionRevisions.status, "pending"),
            sql`EXISTS (
              SELECT 1 FROM ${users}
              WHERE ${users.id} = ${reviewerId} AND ${users.deletedAt} IS NULL
                AND ${users.isModerator} = 1
            )`
          )
        );
    } catch (error) {
      return databaseError("reject", error);
    }

    if (!result.meta?.changes) {
      return this.explainNoOpTransition(extensionId, id, reviewerId);
    }

    return { data: { id, status: "rejected" }, error: null };
  }

  // Approving publishes the revision's content into the extension row. Unlike
  // the pre-0021 flow this touches nothing else: the developer profile is not
  // rewritten, and the extension's id and author are not up for review because
  // a revision cannot propose them.
  //
  // approveAsPublisher shares the pre-checks and the publish statement; the
  // two differ only in who may flip the claim (an active moderator vs. an
  // active can_publish publisher mapping) and in the epoch claim: a publisher
  // submits under its synthetic user, so ownership is asserted by epoch match
  // rather than by owner_user_id = submitted_by.
  private async prepareApproval(
    extensionId: string,
    id: string
  ): Promise<
    | { ok: false; error: DatabaseError }
    | {
        ok: true;
        revision: StoredRevision & { extension_id: string };
        content: ExtensionContent;
      }
  > {
    const existing = await this.getById(extensionId, id);
    if (existing.error || !existing.data) {
      return {
        ok: false,
        error: existing.error ?? revisionNotFound(id).error
      };
    }
    const revision = existing.data as StoredRevision & {
      extension_id: string;
    };

    if (revision.status !== "pending") {
      return {
        ok: false,
        error: { message: "Revision is not pending", code: "CONFLICT" }
      };
    }

    // The stored content is deliberately validated again here rather than
    // trusted from submission time. A revision can predate the current content
    // rules - migration 0021 carries legacy submissions through verbatim - and
    // publishing is the one boundary where the public extension listing's stricter
    // contract has to hold. This is the same reason the pre-0021 code
    // re-checked reserved ids at approval.
    const parsed = ExtensionContentSchema.safeParse(revision.content);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          message:
            "This revision predates the current content requirements and cannot be published as-is; ask the developer to resubmit it",
          code: "CONFLICT"
        }
      };
    }
    try {
      const packageError = await validatePackageContent(
        this.db.$client,
        revision.extension_identifier,
        revision.developer_id,
        parsed.data
      );
      if (packageError) return { ok: false, error: packageError };
    } catch (error) {
      return {
        ok: false,
        error: databaseError("preparePackageApproval", error).error!
      };
    }
    return { ok: true, revision, content: parsed.data };
  }

  // The claim statement's epoch predicate is ownership-change protection,
  // not an owner check: transfers bump the epoch, so a stale proposal fails
  // it whatever `submitted_by` says. That matters because publisher clients
  // submit under their synthetic m2m:<client_id> user, which never equals
  // owner_user_id - matching on owner would make their submissions
  // unapprovable by anyone.

  // The column list publish shares with ExtensionsDatabase.moderatorCorrect()
  // in db/extensions.ts; the two differ only in published_at handling and how
  // the row is matched (exact id here, LOWER(id) there, because corrections
  // address legacy rows). Change the projection in both places together.
  private buildPublishStmt(
    content: ExtensionContent,
    revisionId: string,
    extensionId: string
  ): D1PreparedStatement {
    // published_at is COALESCEd rather than overwritten: it records when the
    // extension first entered the extension directory, and updated_at carries the
    // "changed just now" signal. The WHERE changes() = 1 gates the publish on
    // the immediately-preceding claim statement (SQLite's per-connection
    // changes() function) inside the same D1 batch transaction - a race or
    // ownership change caught by the claim's WHERE also blocks the publish -
    // a guarantee that's easy to silently lose by rewriting this as two
    // independent query-builder calls.
    return toD1Statement(this.db.$client, {
      sql: `UPDATE extensions
            SET type = ?, name = ?, description = ?, releases = ?, website = ?,
                license = ?, icon_url = ?, readme = ?, source = ?, version = ?,
                download_url = ?, manifest = ?,
                published_at = COALESCE(published_at, CURRENT_TIMESTAMP),
                published_revision_id = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE changes() = 1 AND id = ?`,
      params: [
        content.type,
        content.name,
        content.description,
        JSON.stringify(content.releases),
        content.homepage_url ?? "",
        JSON.stringify(content.license),
        packageIconUrl(content),
        content.readme,
        JSON.stringify(content.source),
        content.version,
        content.download_url,
        JSON.stringify(manifestMetadata(content)),
        revisionId,
        extensionId
      ]
    });
  }

  async approve(
    extensionId: string,
    id: string,
    reviewerId: string,
    reviewNote?: string
  ): Promise<DatabaseResult<{ id: string; status: "approved" }>> {
    const prepared = await this.prepareApproval(extensionId, id);
    if (!prepared.ok) {
      return { data: null, error: prepared.error };
    }
    const { revision, content } = prepared;

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
                    AND d.ownership_epoch = extension_revisions.ownership_epoch
                )
                AND EXISTS (
                  SELECT 1 FROM users u
                  WHERE u.id = ? AND u.deleted_at IS NULL AND u.is_moderator = 1
                )`,
        params: [
          reviewerId,
          reviewNote ?? null,
          id,
          revision.extension_id,
          reviewerId
        ]
      });

      const publishStmt = this.buildPublishStmt(
        content,
        id,
        revision.extension_id
      );

      results = await this.db.$client.batch([claimStmt, publishStmt]);
    } catch (error) {
      return databaseError("approve", error);
    }

    if (!results[0]?.meta?.changes) {
      const actorError = await moderatorActorError(this.db, reviewerId);
      return {
        data: null,
        error: actorError ?? {
          message:
            "Revision is not pending, or ownership changed since it was proposed",
          code: "CONFLICT"
        }
      };
    }

    return { data: { id, status: "approved" }, error: null };
  }

  // Publisher auto-approval: the machine revision flip recorded as
  // "[auto publisher=<client_id>]" in review_note. The claim requires the
  // mapping to still be active, can_publish, and to point at the revision's
  // own developer - checked inside the statement, so a concurrent revoke or
  // ownership change cannot slip between the route check and the write.
  async approveAsPublisher(input: {
    extensionId: string;
    revisionId: string;
    clientId: string;
    reviewerId: string;
    reviewNote?: string;
  }): Promise<DatabaseResult<{ id: string; status: "approved" }>> {
    const prepared = await this.prepareApproval(
      input.extensionId,
      input.revisionId
    );
    if (!prepared.ok) {
      return { data: null, error: prepared.error };
    }
    const { revision, content } = prepared;
    const reviewNote = `[auto publisher=${input.clientId}]${
      input.reviewNote ? ` ${input.reviewNote.trim()}` : ""
    }`;

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
                    AND d.ownership_epoch = extension_revisions.ownership_epoch
                )
                AND EXISTS (
                  SELECT 1 FROM m2m_publisher_clients m
                  JOIN developers d ON d.id = m.developer_id
                  WHERE m.client_id = ?
                    AND m.revoked_at IS NULL AND m.can_publish = 1
                    AND m.developer_id = extension_revisions.developer_id
                    AND d.ownership_epoch = extension_revisions.ownership_epoch
                )
                AND EXISTS (
                  SELECT 1 FROM users u
                  WHERE u.id = ? AND u.deleted_at IS NULL
                )`,
        params: [
          input.reviewerId,
          reviewNote,
          input.revisionId,
          revision.extension_id,
          input.clientId,
          input.reviewerId
        ]
      });

      const publishStmt = this.buildPublishStmt(
        content,
        input.revisionId,
        revision.extension_id
      );

      results = await this.db.$client.batch([claimStmt, publishStmt]);
    } catch (error) {
      return databaseError("approveAsPublisher", error);
    }

    if (!results[0]?.meta?.changes) {
      const [mapping] = await this.db
        .select({ one: sql`1` })
        .from(sql`m2m_publisher_clients`)
        .where(
          sql`client_id = ${input.clientId}
              AND revoked_at IS NULL AND can_publish = 1
              AND developer_id = ${revision.developer_id}`
        );
      if (!mapping) {
        return {
          data: null,
          error: {
            message: "Publisher client cannot publish for this developer",
            code: "FORBIDDEN"
          }
        };
      }
      const [stale] = await this.db
        .select({ one: sql`1` })
        .from(sql`m2m_publisher_clients m, developers d`)
        .where(
          sql`m.client_id = ${input.clientId}
              AND m.revoked_at IS NULL
              AND d.id = m.developer_id
              AND d.id = ${revision.developer_id}
              AND m.ownership_epoch != d.ownership_epoch`
        );
      return {
        data: null,
        error: stale
          ? {
              message:
                "Publisher binding is stale after an ownership change; ask a moderator to re-register it",
              code: "FORBIDDEN"
            }
          : {
              message:
                "Revision is not pending, or ownership changed since it was proposed",
              code: "CONFLICT"
            }
      };
    }

    return { data: { id: input.revisionId, status: "approved" }, error: null };
  }
}

function revisionNotFound(id: string): DatabaseResult<never> {
  return {
    data: null,
    error: { message: `Cannot find revision by id: ${id}`, code: "NOT_FOUND" }
  };
}
