import { MAX_CONTENT_BYTES } from "../resource-limits";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { DatabaseError, DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { sortReleasesDescending } from "../../../../lib/releases";
import { parseJSON } from "../../../../lib/json";
import { extensions, extensionRevisions, developers, users } from "./schema";
import {
  databaseError,
  contentAdmissionError,
  inactiveActorError,
  moderatorActorError
} from "./errors";
import { UsersDatabase } from "./users";
import { toD1Statement } from "./batch";
import { developerIsApproved } from "./developer-approval";
import { encodeCursor as encode, decodeCursor as decode } from "./cursor";
import {
  Extension,
  ExtensionContent,
  ExtensionContentSchema,
  ExtensionListItem,
  License,
  OwnedExtension,
  OwnedExtensionListItem,
  StoredExtensionContent,
  Release,
  Repository
} from "../schemas/extensions";
import { PublicDeveloper } from "../schemas/developers";

export const MAX_PENDING_REVISIONS_PER_USER = 10;

// Joined with an inner join everywhere below: developer_id is NOT NULL with a
// foreign key D1 enforces, and migration 0021 fails the deploy rather than
// carry a dangling one through its rebuild.
const DEVELOPER_COLUMNS = {
  developerId: developers.id,
  developerType: developers.type,
  developerName: developers.name,
  developerUrl: developers.url,
  developerAvatarUrl: developers.avatarUrl,
  developerApprovedAt: developers.approvedAt,
  developerApprovedRevision: developers.approvedRevision,
  developerContentRevision: developers.contentRevision,
  developerOwnerUserId: developers.ownerUserId
};

const publishedBytes = extensions.publishedBytes;
// Cards project small fields independently of the full body's size. In
// particular an oversized legacy README must not turn a published row into
// an apparent draft. JSON fields are projected rather than discarded.
const CONTENT_COLUMNS = {
  type: sql<string | null>`substr(${extensions.type}, 1, 100)`,
  name: sql<string | null>`substr(${extensions.name}, 1, 120)`,
  description: sql<string | null>`substr(${extensions.description}, 1, 4000)`,
  releases: extensions.releases,
  website: sql<
    string | null
  >`CASE WHEN length(${extensions.website}) <= 2048 THEN ${extensions.website} ELSE NULL END`,
  license: sql<
    string | null
  >`CASE WHEN length(CAST(${extensions.license} AS BLOB)) <= ${MAX_CONTENT_BYTES} AND json_valid(${extensions.license}) THEN
    json_patch(json_object('name', substr(json_extract(${extensions.license}, '$.name'), 1, 100)),
      json_patch(CASE WHEN json_type(${extensions.license}, '$.spdx_id') = 'text'
        THEN json_object('spdx_id', substr(json_extract(${extensions.license}, '$.spdx_id'), 1, 100)) ELSE '{}' END,
      CASE WHEN json_type(${extensions.license}, '$.URL') = 'text' AND length(json_extract(${extensions.license}, '$.URL')) <= 2048
        THEN json_object('URL', json_extract(${extensions.license}, '$.URL')) ELSE '{}' END))
    ELSE '{"name":"Unavailable"}' END`,
  iconUrl: sql<
    string | null
  >`CASE WHEN length(${extensions.iconUrl}) <= 2048 THEN ${extensions.iconUrl} ELSE NULL END`,
  readme: extensions.readme,
  source: sql<
    string | null
  >`CASE WHEN length(CAST(${extensions.source} AS BLOB)) <= ${MAX_CONTENT_BYTES} AND json_valid(${extensions.source}) THEN
    json_object('type', CASE WHEN json_extract(${extensions.source}, '$.type') IN ('github', 'gitlab', 'custom')
      THEN json_extract(${extensions.source}, '$.type') ELSE 'custom' END,
      'repo', substr(json_extract(${extensions.source}, '$.repo'), 1, 500))
    ELSE '{"type":"custom","repo":"Unavailable"}' END`,
  version: sql<string | null>`substr(${extensions.version}, 1, 100)`,
  downloadUrl: sql<
    string | null
  >`CASE WHEN length(${extensions.downloadUrl}) <= 2048 THEN ${extensions.downloadUrl} ELSE NULL END`
};

// Detail preserves stored fields; the overall size guard prevents oversized reads.
const DETAIL_CONTENT_COLUMNS = {
  type: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.type} ELSE NULL END`,
  name: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.name} ELSE NULL END`,
  description: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.description} ELSE NULL END`,
  releases: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.releases} ELSE NULL END`,
  website: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.website} ELSE NULL END`,
  license: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.license} ELSE NULL END`,
  iconUrl: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.iconUrl} ELSE NULL END`,
  readme: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.readme} ELSE NULL END`,
  source: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.source} ELSE NULL END`,
  version: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.version} ELSE NULL END`,
  downloadUrl: sql<
    string | null
  >`CASE WHEN ${publishedBytes} <= ${MAX_CONTENT_BYTES} THEN ${extensions.downloadUrl} ELSE NULL END`
};

const {
  readme: _readme,
  releases: _releases,
  ...CARD_CONTENT_COLUMNS
} = CONTENT_COLUMNS;

const EXTENSION_COLUMNS = {
  id: extensions.id,
  ...DETAIL_CONTENT_COLUMNS,
  publishedBytes,
  ...DEVELOPER_COLUMNS
};

const EXTENSION_LIST_COLUMNS = {
  id: extensions.id,
  ...CARD_CONTENT_COLUMNS,
  publishedBytes,
  ...DEVELOPER_COLUMNS
};

// The owner view joins extension_revisions twice: once for the unreviewed
// edit (at most one - idx_extension_revisions_pending), once for the most
// recent decision. "Most recently reviewed" is not expressible as a join
// predicate, so that side matches on a correlated subquery instead.
//
// The tie-break is rowid, not id. reviewed_at comes from CURRENT_TIMESTAMP and
// is only second-granular, so two reviews can share one, and id is a random
// UUID that would then pick a winner at random. rowid is assigned in insert
// order, and revisions on one extension are strictly serialised - only one may
// be pending at a time - so insert order is review order.
const PENDING = alias(extensionRevisions, "pending");
const REVIEWED = alias(extensionRevisions, "reviewed");

const PENDING_JOIN = and(
  eq(PENDING.extensionId, extensions.id),
  eq(PENDING.status, "pending")
)!;

const REVIEWED_JOIN = eq(
  REVIEWED.id,
  sql`(
    SELECT r.id FROM ${extensionRevisions} r
    WHERE r.extension_id = ${extensions.id}
      AND r.status IN ('approved', 'rejected')
    ORDER BY r.reviewed_at DESC, r.rowid DESC
    LIMIT 1
  )`
);

const REVIEW_COLUMNS = {
  pendingId: PENDING.id,
  pendingCreatedAt: PENDING.createdAt,
  reviewedId: REVIEWED.id,
  reviewedStatus: REVIEWED.status,
  reviewedNote: sql<string | null>`substr(${REVIEWED.reviewNote}, 1, 2000)`,
  reviewedAt: REVIEWED.reviewedAt
};

// The owner list drops the same two large published fields the catalogue does,
// and the pending revision's stored content (up to 256 KiB per row) with it.
const OWNED_LIST_COLUMNS = {
  id: extensions.id,
  publishedAt: extensions.publishedAt,
  delistedAt: extensions.delistedAt,
  delistReason: sql<string | null>`substr(${extensions.delistReason}, 1, 2000)`,
  createdAt: extensions.createdAt,
  updatedAt: extensions.updatedAt,
  ...CARD_CONTENT_COLUMNS,
  ...DEVELOPER_COLUMNS,
  ...REVIEW_COLUMNS
};

const OWNED_COLUMNS = {
  ...OWNED_LIST_COLUMNS,
  ...DETAIL_CONTENT_COLUMNS,
  pendingContent: sql<
    string | null
  >`CASE WHEN length(CAST(${PENDING.content} AS BLOB)) <= ${MAX_CONTENT_BYTES} THEN ${PENDING.content} ELSE NULL END`,
  pendingBytes: sql<number>`COALESCE(length(CAST(${PENDING.content} AS BLOB)),0)`,
  publishedBytes
};

// Repeated rather than factored out: drizzle's builder types are keyed on the
// selection, so a generic wrapper over it loses the join methods.
const ownedListQuery = (db: ExtensionsDb) =>
  db
    .select(OWNED_LIST_COLUMNS)
    .from(extensions)
    .innerJoin(developers, eq(extensions.developerId, developers.id))
    .leftJoin(PENDING, PENDING_JOIN)
    .leftJoin(REVIEWED, REVIEWED_JOIN);

const ownedQuery = (db: ExtensionsDb) =>
  db
    .select(OWNED_COLUMNS)
    .from(extensions)
    .innerJoin(developers, eq(extensions.developerId, developers.id))
    .leftJoin(PENDING, PENDING_JOIN)
    .leftJoin(REVIEWED, REVIEWED_JOIN);

// Taken from the queries rather than restated, so a column added to either
// select map cannot drift from what the parsers below expect.
type OwnedListRow = Awaited<ReturnType<typeof ownedListQuery>>[number];
type OwnedRow = Awaited<ReturnType<typeof ownedQuery>>[number];

interface DeveloperRow {
  developerId: string;
  developerType: string;
  developerName: string;
  developerUrl: string | null;
  developerAvatarUrl: string | null;
  developerApprovedAt: string | null;
  developerApprovedRevision: number | null;
  developerContentRevision: number;
  developerOwnerUserId: string | null;
}

// The content columns are nullable in the table (an extension exists before
// it is published) but every query that produces this row filters on
// published_at IS NOT NULL, and extensions_published_content_check makes that
// filter sufficient: a published row cannot be missing any of them. That
// constraint is what makes the non-null types here sound.
interface PublishedRow extends DeveloperRow {
  id: string;
  type: string;
  name: string;
  description: string;
  releases: string;
  website: string;
  license: string;
  iconUrl: string | null;
  readme: string;
  source: string;
  version: string;
  downloadUrl: string;
  publishedBytes: number;
}

type PublishedListRow = Omit<
  PublishedRow,
  "readme" | "releases" | "website" | "downloadUrl"
> & { website: string | null; downloadUrl: string | null };

export interface ExtensionListFilters {
  type?: string;
  developerId?: string;
  limit?: number;
  cursor?: string;
}

export interface ExtensionListPage {
  items: ExtensionListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface OwnedExtensionListPage {
  items: OwnedExtensionListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface ExtensionCursor {
  normalizedId: string;
  id: string;
}

export interface CreateExtensionInput {
  extensionId: string;
  developerId: string;
  ownershipEpoch: number;
  submittedBy: string;
  content: ExtensionContent;
}

export class ExtensionsDatabase {
  constructor(private db: ExtensionsDb) {}

  async list(
    filters: ExtensionListFilters = {}
  ): Promise<DatabaseResult<ExtensionListPage>> {
    const limit = filters.limit ?? 50;
    const conditions = [
      isNotNull(extensions.publishedAt),
      sql`${extensions.publishedBytes} <= ${MAX_CONTENT_BYTES}`,
      isNull(extensions.delistedAt)
    ];
    if (filters.type) conditions.push(eq(extensions.type, filters.type));
    if (filters.developerId)
      conditions.push(eq(extensions.developerId, filters.developerId));

    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor);
      if (!cursor) return invalidCursor();
      conditions.push(keysetAfter(cursor));
    }

    let rows: PublishedListRow[];
    try {
      rows = (await this.db
        .select(EXTENSION_LIST_COLUMNS)
        .from(extensions)
        .innerJoin(developers, eq(extensions.developerId, developers.id))
        .where(and(...conditions))
        .orderBy(asc(sql`LOWER(${extensions.id})`), asc(extensions.id))
        .limit(limit + 1)) as PublishedListRow[];
    } catch (error) {
      return databaseError("list", error);
    }

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      data: {
        items: pageRows.map((row) => parseListRow(row)),
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.id) : null
      },
      error: null
    };
  }

  async getById(id: string): Promise<DatabaseResult<Extension>> {
    let rows: PublishedRow[];
    try {
      rows = (await this.db
        .select(EXTENSION_COLUMNS)
        .from(extensions)
        .innerJoin(developers, eq(extensions.developerId, developers.id))
        .where(
          and(
            sql`LOWER(${extensions.id}) = LOWER(${id})`,
            isNotNull(extensions.publishedAt),
            isNull(extensions.delistedAt)
          )
        )) as PublishedRow[];
    } catch (error) {
      return databaseError("getById", error);
    }

    const row = rows[0];
    if (!row) return notFound(id);
    if (row.publishedBytes > MAX_CONTENT_BYTES) return oversizedContent();
    try {
      return { data: parseRow(row), error: null };
    } catch (error) {
      if (error instanceof LegacyContentError) return oversizedContent();
      return databaseError("getById", error);
    }
  }

  async listOwned(filters: {
    developerId: string;
    type?: string;
    limit?: number;
    cursor?: string;
  }): Promise<DatabaseResult<OwnedExtensionListPage>> {
    const limit = filters.limit ?? 50;
    const conditions = [eq(extensions.developerId, filters.developerId)];
    // extensions.type is NULL until a first approval, so filtering the column
    // alone would hide every draft and every rejected extension from their own
    // owner. Fall back to the type the unreviewed edit proposes, then to the
    // last reviewed one, which between them cover both unpublished states.
    if (filters.type) {
      conditions.push(
        sql`COALESCE(
          ${extensions.type},
          json_extract(${PENDING.content}, '$.type'),
          json_extract(${REVIEWED.content}, '$.type')
        ) = ${filters.type}`
      );
    }
    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor);
      if (!cursor) return invalidCursor();
      conditions.push(keysetAfter(cursor));
    }

    let rows: OwnedListRow[];
    try {
      rows = await ownedListQuery(this.db)
        .where(and(...conditions))
        .orderBy(asc(sql`LOWER(${extensions.id})`), asc(extensions.id))
        .limit(limit + 1);
    } catch (error) {
      return databaseError("listOwned", error);
    }

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      data: {
        items: pageRows.map(parseOwnedListRow),
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.id) : null
      },
      error: null
    };
  }

  // The moderator equivalent of listOwned(): every extension regardless of
  // who owns it, filterable by the same published/delisted/unpublished states
  // rather than scoped to one developerId. Shares ownedListQuery and its
  // parser so a moderator's list can never disagree with an owner's about
  // what one row means.
  async listForModeration(
    filters: {
      status?: "published" | "delisted" | "unpublished";
      type?: string;
      q?: string;
      limit?: number;
      cursor?: string;
    } = {}
  ): Promise<DatabaseResult<OwnedExtensionListPage>> {
    const limit = filters.limit ?? 50;
    const conditions = [];
    if (filters.status === "published") {
      conditions.push(
        isNotNull(extensions.publishedAt),
        isNull(extensions.delistedAt)
      );
    } else if (filters.status === "delisted") {
      conditions.push(isNotNull(extensions.delistedAt));
    } else if (filters.status === "unpublished") {
      conditions.push(isNull(extensions.publishedAt));
    }
    if (filters.q) {
      // LOWER() on both sides rather than lowercasing the term in JS first:
      // JS's toLowerCase() is Unicode-aware, but SQLite's LOWER() only folds
      // ASCII, so pre-folding just the term could desync from what LOWER(id)
      // produces for a non-ASCII id.
      const pattern = `%${escapeLikePattern(filters.q)}%`;
      conditions.push(
        sql`LOWER(${extensions.id}) LIKE LOWER(${pattern}) ESCAPE '\\'`
      );
    }
    if (filters.type) {
      conditions.push(
        sql`COALESCE(
          ${extensions.type},
          json_extract(${PENDING.content}, '$.type'),
          json_extract(${REVIEWED.content}, '$.type')
        ) = ${filters.type}`
      );
    }
    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor);
      if (!cursor) return invalidCursor();
      conditions.push(keysetAfter(cursor));
    }

    let rows: OwnedListRow[];
    try {
      const query = ownedListQuery(this.db);
      rows = await (conditions.length ? query.where(and(...conditions)) : query)
        .orderBy(asc(sql`LOWER(${extensions.id})`), asc(extensions.id))
        .limit(limit + 1);
    } catch (error) {
      return databaseError("listForModeration", error);
    }

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      data: {
        items: pageRows.map(parseOwnedListRow),
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.id) : null
      },
      error: null
    };
  }

  // Catalogue totals for the admin tabs, using the same published /
  // delisted / unpublished predicates as listForModeration so the badges
  // can never disagree with what each tab lists. One conditional-SUM
  // query rather than four COUNTs.
  async countForModeration(): Promise<
    DatabaseResult<{
      all: number;
      published: number;
      delisted: number;
      unpublished: number;
    }>
  > {
    let rows: Array<{
      all: number;
      published: number;
      delisted: number;
      unpublished: number;
    }>;
    try {
      rows = await this.db
        .select({
          all: sql<number>`COUNT(*)`,
          published: sql<number>`COALESCE(SUM(CASE WHEN ${extensions.publishedAt} IS NOT NULL AND ${extensions.delistedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
          delisted: sql<number>`COALESCE(SUM(CASE WHEN ${extensions.delistedAt} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
          unpublished: sql<number>`COALESCE(SUM(CASE WHEN ${extensions.publishedAt} IS NULL THEN 1 ELSE 0 END), 0)`
        })
        .from(extensions);
    } catch (error) {
      return databaseError("countForModeration", error);
    }
    return {
      data: rows[0] ?? { all: 0, published: 0, delisted: 0, unpublished: 0 },
      error: null
    };
  }

  // Light authorisation probe for the merged public/owner detail read and
  // the revisions route: deciding which view a caller gets - and learning
  // the canonical id for exact-match scoped queries - must not cost the
  // full owner view (two revision joins plus up to 256 KiB of
  // pendingContent).
  async getOwnership(
    id: string
  ): Promise<
    DatabaseResult<{ extensionId: string; ownerUserId: string | null }>
  > {
    try {
      const rows = await this.db
        .select({
          extensionId: extensions.id,
          ownerUserId: developers.ownerUserId
        })
        .from(extensions)
        .innerJoin(developers, eq(extensions.developerId, developers.id))
        .where(sql`LOWER(${extensions.id}) = LOWER(${id})`);

      const row = rows[0];
      if (!row) return notFound(id);
      return {
        data: { extensionId: row.extensionId, ownerUserId: row.ownerUserId },
        error: null
      };
    } catch (error) {
      return databaseError("getOwnership", error);
    }
  }

  // Returns the owner view plus the two ids a route needs to authorise the
  // caller, so a detail read is one query rather than a fetch-then-check.
  async getOwned(
    id: string
  ): Promise<
    DatabaseResult<{ extension: OwnedExtension; ownerUserId: string | null }>
  > {
    let rows: OwnedRow[];
    try {
      rows = await ownedQuery(this.db).where(
        sql`LOWER(${extensions.id}) = LOWER(${id})`
      );
    } catch (error) {
      return databaseError("getOwned", error);
    }

    const row = rows[0];
    if (!row) return notFound(id);
    if (
      row.publishedBytes > MAX_CONTENT_BYTES ||
      row.pendingBytes > MAX_CONTENT_BYTES
    )
      return oversizedContent();
    try {
      return {
        data: {
          extension: parseOwnedRow(row),
          ownerUserId: row.developerOwnerUserId
        },
        error: null
      };
    } catch (error) {
      if (error instanceof LegacyContentError) return oversizedContent();
      return databaseError("getOwned", error);
    }
  }

  // Creates the extension record and its first pending revision as one
  // transaction. The revision insert is gated on `changes() = 1` from the
  // preceding statement (SQLite's per-connection changes()), so an id
  // collision or a failed ownership guard leaves neither row behind. See
  // toD1Statement for why this is raw sql rather than two builder calls.
  async create(
    input: CreateExtensionInput
  ): Promise<DatabaseResult<{ id: string; revisionId: string }>> {
    const revisionId = crypto.randomUUID();

    let results;
    try {
      const extensionStmt = toD1Statement(this.db.$client, {
        sql: `INSERT INTO extensions (id, developer_id, created_by, created_at, updated_at)
              SELECT ?, d.id, d.owner_user_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
              FROM developers d
              WHERE d.id = ? AND d.owner_user_id = ? AND d.ownership_epoch = ?
                AND EXISTS (
                  SELECT 1 FROM users u WHERE u.id = ? AND u.deleted_at IS NULL
                )
                AND (
                  SELECT COUNT(*) FROM extension_revisions
                  WHERE submitted_by = ? AND status = 'pending'
                ) < ?
              ON CONFLICT DO NOTHING`,
        params: [
          input.extensionId,
          input.developerId,
          input.submittedBy,
          input.ownershipEpoch,
          input.submittedBy,
          input.submittedBy,
          MAX_PENDING_REVISIONS_PER_USER
        ]
      });

      const revisionStmt = toD1Statement(this.db.$client, {
        sql: `INSERT INTO extension_revisions
                (id, extension_id, developer_id, submitted_by, status, content, ownership_epoch)
              SELECT ?, ?, ?, ?, 'pending', ?, ?
              WHERE changes() = 1`,
        params: [
          revisionId,
          input.extensionId,
          input.developerId,
          input.submittedBy,
          JSON.stringify(input.content),
          input.ownershipEpoch
        ]
      });

      results = await this.db.$client.batch([extensionStmt, revisionStmt]);
    } catch (error) {
      return contentAdmissionError("create", error);
    }

    if (!results[0]?.meta?.changes) {
      try {
        return { data: null, error: await this.createBlockedError(input) };
      } catch (error) {
        return contentAdmissionError("create", error);
      }
    }

    return { data: { id: input.extensionId, revisionId }, error: null };
  }

  // The insert affected no rows: either ON CONFLICT DO NOTHING swallowed an id
  // collision, or the WHERE guard rejected the caller. Only the first has a
  // specific message, so look for the row that would have caused it.
  private async createBlockedError(
    input: CreateExtensionInput
  ): Promise<DatabaseError> {
    const inactive = await inactiveActorError(this.db, input.submittedBy);
    if (inactive) return inactive;

    const [taken] = await this.db
      .select({ one: sql`1` })
      .from(extensions)
      .where(sql`LOWER(${extensions.id}) = LOWER(${input.extensionId})`);
    if (taken) {
      return {
        message: "An extension with this id already exists",
        code: "CONFLICT"
      };
    }
    return {
      message:
        "Extension could not be created because ownership changed or the pending-revision limit was reached",
      code: "CONFLICT"
    };
  }

  // Withdrawing is only offered while an extension has never been published:
  // once it is in the catalogue, consumers pin its id and removing it is a
  // moderator's decision, not the owner's.
  async withdraw(
    id: string,
    ownerUserId: string
  ): Promise<DatabaseResult<{ id: string }>> {
    let result;
    try {
      result = await this.db.run(sql`
        DELETE FROM ${extensions}
        WHERE LOWER(id) = LOWER(${id})
          AND published_at IS NULL
          AND developer_id IN (
            SELECT d.id FROM ${developers} d WHERE d.owner_user_id = ${ownerUserId}
          )
          AND EXISTS (
            SELECT 1 FROM ${users} u
            WHERE u.id = ${ownerUserId} AND u.deleted_at IS NULL
          )
      `);
    } catch (error) {
      return databaseError("withdraw", error);
    }

    if (!result.meta?.changes) {
      return this.withdrawBlockedError(id, ownerUserId);
    }

    return { data: { id }, error: null };
  }

  // Separates the four ways the delete can affect no rows, so the route can
  // answer 404/403/409 rather than one opaque failure. The active-account
  // check is repeated inside the statement above rather than trusted from
  // requireActiveAuth(), which can only reject before the write; a deletion
  // landing in between would otherwise still take effect.
  private async withdrawBlockedError(
    id: string,
    ownerUserId: string
  ): Promise<DatabaseResult<never>> {
    const inactive = await inactiveActorError(this.db, ownerUserId);
    if (inactive) return { data: null, error: inactive };

    const [existing] = await this.db
      .select({
        publishedAt: extensions.publishedAt,
        ownerUserId: developers.ownerUserId
      })
      .from(extensions)
      .innerJoin(developers, eq(extensions.developerId, developers.id))
      .where(sql`LOWER(${extensions.id}) = LOWER(${id})`);
    if (!existing) return notFound(id);
    if (existing.publishedAt) {
      return {
        data: null,
        error: {
          message: "A published extension cannot be withdrawn",
          code: "CONFLICT"
        }
      };
    }
    if (existing.ownerUserId !== ownerUserId) {
      return {
        data: null,
        error: { message: "You do not own this extension", code: "FORBIDDEN" }
      };
    }
    return {
      data: null,
      error: {
        message: "Extension could not be withdrawn",
        code: "CONFLICT"
      }
    };
  }

  // A moderator's decision to pull an already-published extension from the
  // catalogue for cause - its upstream source disappearing, for example.
  // Content and history are kept (unlike withdraw(), which deletes a
  // never-published row outright), so an owner can still see why and a
  // moderator can re-list it later without the developer resubmitting from
  // scratch. `AND delisted_at IS NULL` makes this a single atomic
  // check-and-set, the same way ExtensionRevisionsDatabase.reject() guards
  // on `status = 'pending'`.
  async delist(
    id: string,
    moderatorId: string,
    reason: string
  ): Promise<DatabaseResult<{ id: string }>> {
    let result;
    try {
      result = await this.db
        .update(extensions)
        .set({
          delistedAt: sql`CURRENT_TIMESTAMP`,
          delistReason: reason,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            sql`LOWER(${extensions.id}) = LOWER(${id})`,
            isNotNull(extensions.publishedAt),
            isNull(extensions.delistedAt),
            sql`EXISTS (
              SELECT 1 FROM ${users}
              WHERE ${users.id} = ${moderatorId} AND ${users.deletedAt} IS NULL
                AND ${users.isModerator} = 1
            )`
          )
        );
    } catch (error) {
      return databaseError("delist", error);
    }

    if (!result.meta?.changes) {
      return this.delistBlockedError(id, moderatorId);
    }

    return { data: { id }, error: null };
  }

  // Separates the three ways delist()'s guard can affect no rows, so the
  // route can answer 404/409 rather than one opaque failure.
  private async delistBlockedError(
    id: string,
    moderatorId: string
  ): Promise<DatabaseResult<never>> {
    const actorError = await moderatorActorError(this.db, moderatorId);
    if (actorError) return { data: null, error: actorError };

    let existing:
      { publishedAt: string | null; delistedAt: string | null } | undefined;
    try {
      [existing] = await this.db
        .select({
          publishedAt: extensions.publishedAt,
          delistedAt: extensions.delistedAt
        })
        .from(extensions)
        .where(sql`LOWER(${extensions.id}) = LOWER(${id})`);
    } catch (error) {
      return databaseError("delist", error);
    }
    if (!existing) return notFound(id);
    if (!existing.publishedAt) {
      return {
        data: null,
        error: {
          message: "Only a published extension can be delisted",
          code: "CONFLICT"
        }
      };
    }
    if (existing.delistedAt) {
      return {
        data: null,
        error: {
          message: "This extension is already delisted",
          code: "CONFLICT"
        }
      };
    }
    return {
      data: null,
      error: { message: "Extension could not be delisted", code: "CONFLICT" }
    };
  }

  // Inverse of delist(): restores a delisted-but-published extension to the
  // catalogue. Content and history are untouched; only the delist markers
  // are cleared. `AND delisted_at IS NOT NULL` makes this a single atomic
  // check-and-set mirroring delist(). The actor guard re-checks moderator
  // status inside the statement (not just activity): requireModerator()
  // can only reject before the write, and a role revoked in between must
  // still fail the write itself. RETURNING hands back the stored canonical
  // id, which can differ in case from the path param.
  async relist(
    id: string,
    moderatorId: string
  ): Promise<DatabaseResult<{ id: string }>> {
    let rows;
    try {
      rows = await this.db
        .update(extensions)
        .set({
          delistedAt: null,
          delistReason: null,
          updatedAt: sql`CURRENT_TIMESTAMP`
        })
        .where(
          and(
            sql`LOWER(${extensions.id}) = LOWER(${id})`,
            isNotNull(extensions.publishedAt),
            isNotNull(extensions.delistedAt),
            sql`EXISTS (
              SELECT 1 FROM ${users}
              WHERE ${users.id} = ${moderatorId}
                AND ${users.deletedAt} IS NULL
                AND ${users.isModerator} = 1
            )`
          )
        )
        .returning({ id: extensions.id });
    } catch (error) {
      return databaseError("relist", error);
    }

    const [row] = rows;
    if (!row) {
      return this.relistBlockedError(id, moderatorId);
    }

    return { data: { id: row.id }, error: null };
  }

  private async relistBlockedError(
    id: string,
    moderatorId: string
  ): Promise<DatabaseResult<never>> {
    // One row answers both halves of the actor check, matching the
    // in-statement guard above: a moderator deactivated or demoted after
    // requireModerator() ran fails the write, and must be told so (403)
    // rather than misreported as a state conflict.
    const access = await new UsersDatabase(this.db).moderatorAccess(
      moderatorId
    );
    if (access.error || !access.data) {
      return {
        data: null,
        error: access.error ?? {
          message: "Active account required",
          code: "ACCOUNT_INACTIVE"
        }
      };
    }
    if (!access.data.active) {
      return {
        data: null,
        error: {
          message: "Active account required",
          code: "ACCOUNT_INACTIVE"
        }
      };
    }
    if (!access.data.moderator) {
      return {
        data: null,
        error: { message: "Moderator access required", code: "FORBIDDEN" }
      };
    }

    let existing:
      { publishedAt: string | null; delistedAt: string | null } | undefined;
    try {
      [existing] = await this.db
        .select({
          publishedAt: extensions.publishedAt,
          delistedAt: extensions.delistedAt
        })
        .from(extensions)
        .where(sql`LOWER(${extensions.id}) = LOWER(${id})`);
    } catch (error) {
      return databaseError("relist", error);
    }
    if (!existing) return notFound(id);
    if (!existing.publishedAt) {
      return {
        data: null,
        error: {
          message: "Only a published extension can be relisted",
          code: "CONFLICT"
        }
      };
    }
    if (!existing.delistedAt) {
      return {
        data: null,
        error: {
          message: "This extension is not delisted",
          code: "CONFLICT"
        }
      };
    }
    return {
      data: null,
      error: { message: "Extension could not be relisted", code: "CONFLICT" }
    };
  }

  // Moderator correction of live catalogue content (api#251): a truncated
  // readme or broken link the owner should not have to resubmit to fix. One
  // D1 batch() like approve(): the first statement inserts an
  // already-approved revision row (submitted_by and reviewer both the
  // moderator, ownership_epoch carried from the owner row), the second
  // publishes it gated on `changes() = 1`. published_at is left untouched
  // and ownership never written; guards on published, listed, no pending
  // revision, and active moderator.
  async moderatorCorrect(
    id: string,
    moderatorId: string,
    content: ExtensionContent,
    correctionNote: string
  ): Promise<DatabaseResult<{ id: string; revisionId: string }>> {
    const parsed = ExtensionContentSchema.safeParse(content);
    if (!parsed.success) {
      return {
        data: null,
        error: {
          message: "Extension content failed validation",
          code: "CONFLICT"
        }
      };
    }
    const valid = parsed.data;
    const revisionId = crypto.randomUUID();

    let results;
    try {
      const correctStmt = toD1Statement(this.db.$client, {
        sql: `INSERT INTO extension_revisions
                (id, extension_id, developer_id, submitted_by, status, content,
                 reviewer_id, review_note, reviewed_at, ownership_epoch)
              SELECT ?, e.id, e.developer_id, ?, 'approved', ?, ?, ?, CURRENT_TIMESTAMP, d.ownership_epoch
              FROM extensions e
              JOIN developers d ON d.id = e.developer_id
              WHERE LOWER(e.id) = LOWER(?)
                AND e.published_at IS NOT NULL
                AND e.delisted_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM extension_revisions r
                  WHERE r.extension_id = e.id AND r.status = 'pending'
                )
                AND EXISTS (
                  SELECT 1 FROM users u
                  WHERE u.id = ? AND u.deleted_at IS NULL AND u.is_moderator = 1
                )
              RETURNING extension_id`,
        params: [
          revisionId,
          moderatorId,
          JSON.stringify(valid),
          moderatorId,
          correctionNote,
          id,
          moderatorId
        ]
      });

      const publishStmt = toD1Statement(this.db.$client, {
        sql: `UPDATE extensions
              SET type = ?, name = ?, description = ?, releases = ?, website = ?,
                  license = ?, icon_url = ?, readme = ?, source = ?, version = ?,
                  download_url = ?,
                  published_revision_id = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE changes() = 1 AND LOWER(id) = LOWER(?)`,
        params: [
          valid.type,
          valid.name,
          valid.description,
          JSON.stringify(valid.releases),
          valid.website,
          JSON.stringify(valid.license),
          valid.icon_url ?? null,
          valid.readme,
          JSON.stringify(valid.source),
          valid.version,
          valid.download_url,
          revisionId,
          id
        ]
      });

      results = await this.db.$client.batch([correctStmt, publishStmt]);
    } catch (error) {
      return contentAdmissionError("moderatorCorrect", error);
    }

    if (!results[0]?.meta?.changes) {
      return this.moderatorCorrectBlockedError(id, moderatorId);
    }

    return {
      data: {
        id: (results[0].results[0] as { extension_id: string }).extension_id,
        revisionId
      },
      error: null
    };
  }

  // Separates the ways moderatorCorrect()'s guard can affect no rows, so the
  // route can answer 403/404/409 rather than one opaque failure. Mirrors
  // relistBlockedError's actor check first: a moderator deactivated or
  // demoted after requireModerator() ran fails the write and must be told so.
  private async moderatorCorrectBlockedError(
    id: string,
    moderatorId: string
  ): Promise<DatabaseResult<never>> {
    const access = await new UsersDatabase(this.db).moderatorAccess(
      moderatorId
    );
    if (access.error || !access.data) {
      return {
        data: null,
        error: access.error ?? {
          message: "Active account required",
          code: "ACCOUNT_INACTIVE"
        }
      };
    }
    if (!access.data.active) {
      return {
        data: null,
        error: {
          message: "Active account required",
          code: "ACCOUNT_INACTIVE"
        }
      };
    }
    if (!access.data.moderator) {
      return {
        data: null,
        error: { message: "Moderator access required", code: "FORBIDDEN" }
      };
    }

    let existing:
      { publishedAt: string | null; delistedAt: string | null } | undefined;
    try {
      [existing] = await this.db
        .select({
          publishedAt: extensions.publishedAt,
          delistedAt: extensions.delistedAt
        })
        .from(extensions)
        .where(sql`LOWER(${extensions.id}) = LOWER(${id})`);
    } catch (error) {
      return databaseError("moderatorCorrect", error);
    }
    if (!existing) return notFound(id);
    if (!existing.publishedAt) {
      return {
        data: null,
        error: {
          message: "Only a published extension can be corrected",
          code: "CONFLICT"
        }
      };
    }
    if (existing.delistedAt) {
      return {
        data: null,
        error: {
          message: "A delisted extension cannot be corrected; relist it first",
          code: "CONFLICT"
        }
      };
    }

    try {
      const [pending] = await this.db
        .select({ one: sql`1` })
        .from(extensionRevisions)
        .where(
          and(
            sql`LOWER(${extensionRevisions.extensionId}) = LOWER(${id})`,
            eq(extensionRevisions.status, "pending")
          )
        );
      if (pending) {
        return {
          data: null,
          error: {
            message:
              "An edit to this extension is already awaiting review; approve or reject it first",
            code: "CONFLICT"
          }
        };
      }
    } catch (error) {
      return databaseError("moderatorCorrect", error);
    }
    return {
      data: null,
      error: { message: "Extension could not be corrected", code: "CONFLICT" }
    };
  }
}

// Escapes SQLite LIKE metacharacters in a caller-supplied search term so a
// literal "%" or "_" in it is matched literally rather than as a wildcard.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function invalidCursor(): DatabaseResult<never> {
  return {
    data: null,
    error: { message: "Invalid pagination cursor", code: "INVALID_CURSOR" }
  };
}

function notFound(id: string): DatabaseResult<never> {
  return {
    data: null,
    error: { message: `Cannot find extension by id: ${id}`, code: "NOT_FOUND" }
  };
}

function keysetAfter(cursor: ExtensionCursor) {
  return or(
    sql`LOWER(${extensions.id}) > ${cursor.normalizedId}`,
    and(
      sql`LOWER(${extensions.id}) = ${cursor.normalizedId}`,
      sql`${extensions.id} > ${cursor.id}`
    )
  )!;
}

function encodeCursor(id: string): string {
  return encode({ normalizedId: id.toLowerCase(), id });
}

// normalizedId is checked against id rather than trusted: it drives the
// keyset comparison, so a tampered cursor could otherwise seek from a
// position the id itself doesn't correspond to.
function isExtensionCursor(
  parsed: Record<string, unknown>
): parsed is ExtensionCursor & Record<string, unknown> {
  return (
    typeof parsed.id === "string" &&
    typeof parsed.normalizedId === "string" &&
    parsed.normalizedId === parsed.id.toLowerCase()
  );
}

function decodeCursor(value: string): ExtensionCursor | null {
  return decode(value, isExtensionCursor);
}

export function isValidExtensionCursor(value: string): boolean {
  return decodeCursor(value) !== null;
}

function parseDeveloper(row: DeveloperRow): PublicDeveloper {
  return {
    id: row.developerId,
    type: row.developerType as "user" | "organization",
    name: row.developerName,
    URL: row.developerUrl ?? undefined,
    avatar_url: row.developerAvatarUrl ?? undefined,
    approved: developerIsApproved({
      approvedAt: row.developerApprovedAt,
      approvedRevision: row.developerApprovedRevision,
      contentRevision: row.developerContentRevision
    }),
    unclaimed: row.developerOwnerUserId === null
  };
}

// Shared by both parsers so the catalogue card and the detail view can never
// disagree about the embedded developer.
function cardUrl(url: string | null): string | null {
  return url && url.length <= 2048 ? url : null;
}

function cardLicense(stored: string | null): License {
  const license = parseJSON<License>(stored ?? "", { name: "Unavailable" });
  license.name =
    typeof license.name === "string" && license.name
      ? license.name.slice(0, 100)
      : "Unavailable";
  if (license.URL && license.URL.length > 2048) delete license.URL;
  return license;
}

function cardSource(stored: string | null): Repository {
  const source = parseJSON<Repository>(stored ?? "", {
    type: "custom",
    repo: "Unavailable"
  });
  source.repo =
    typeof source.repo === "string" && source.repo
      ? source.repo.slice(0, 500)
      : "Unavailable";
  return source;
}

function parseListRow(row: PublishedListRow, card = true): ExtensionListItem {
  return {
    id: row.id,
    type: row.type as ExtensionListItem["type"],
    name: card ? row.name.slice(0, 120) : row.name,
    description: card ? row.description.slice(0, 4000) : row.description,
    website: card ? cardUrl(row.website) : row.website,
    license: card
      ? cardLicense(row.license)
      : parseJSON<License>(row.license, { name: "" }),
    icon_url: (card ? cardUrl(row.iconUrl) : row.iconUrl) ?? undefined,
    source: card
      ? cardSource(row.source)
      : parseJSON<Repository>(row.source, { type: "custom", repo: "" }),
    version: card ? row.version.slice(0, 100) : row.version,
    download_url: card ? cardUrl(row.downloadUrl) : row.downloadUrl,
    developer: parseDeveloper(row)
  };
}

// The detail view is the list projection plus the two large fields the
// catalogue query deliberately omits.
function parseRow(row: PublishedRow): Extension {
  return {
    ...parseListRow(row, false),
    website: row.website,
    download_url: row.downloadUrl,
    readme: row.readme,
    releases: boundedReleases(parseJSON<Release[]>(row.releases, []))
  };
}

// Only ever called for a row whose published_at is set, where
// extensions_published_content_check guarantees each of these is present.
function publishedContent(
  row: OwnedListRow,
  card = true
): NonNullable<OwnedExtensionListItem["published"]> {
  return {
    type: row.type as ExtensionContent["type"],
    name: card ? (row.name as string).slice(0, 120) : (row.name as string),
    description: card
      ? (row.description as string).slice(0, 4000)
      : (row.description as string),
    website: card ? cardUrl(row.website) : row.website,
    license: card
      ? cardLicense(row.license)
      : parseJSON<License>(row.license as string, { name: "" }),
    icon_url: (card ? cardUrl(row.iconUrl) : row.iconUrl) ?? undefined,
    source: card
      ? cardSource(row.source)
      : parseJSON<Repository>(row.source as string, {
          type: "custom",
          repo: ""
        }),
    version: card
      ? (row.version as string).slice(0, 100)
      : (row.version as string),
    download_url: card ? cardUrl(row.downloadUrl) : row.downloadUrl
  };
}

function parseOwnedListRow(row: OwnedListRow): OwnedExtensionListItem {
  return {
    id: row.id,
    developer: parseDeveloper(row),
    published: row.publishedAt ? publishedContent(row) : null,
    pending_revision:
      row.pendingId && row.pendingCreatedAt
        ? { id: row.pendingId, created_at: row.pendingCreatedAt }
        : null,
    last_review: row.reviewedId
      ? {
          revision_id: row.reviewedId,
          status: row.reviewedStatus as "approved" | "rejected",
          review_note: row.reviewedNote,
          reviewed_at: row.reviewedAt
        }
      : null,
    // delistReason is only ever null alongside delistedAt - delist() sets
    // both in the same statement - so the cast below just states that.
    delisted: row.delistedAt
      ? { reason: row.delistReason as string, at: row.delistedAt }
      : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt
  };
}

function parseOwnedRow(row: OwnedRow): OwnedExtension {
  return {
    ...parseOwnedListRow(row),
    published: row.publishedAt
      ? {
          ...publishedContent(row, false),
          website: row.website as string,
          download_url: row.downloadUrl as string,
          readme: row.readme as string,
          releases: boundedReleases(
            parseJSON<Release[]>(row.releases as string, [])
          )
        }
      : null,
    pending_revision:
      row.pendingId && row.pendingCreatedAt
        ? {
            id: row.pendingId,
            created_at: row.pendingCreatedAt,
            content: parseContent(row.pendingContent)
          }
        : null
  };
}

// Migrated revisions can hold content that predates the current schema (see
// migration 0021), so releases is defaulted rather than assumed.
export function parseContent(stored: string | null): StoredExtensionContent {
  const content = parseJSON<StoredExtensionContent>(stored ?? "", {});
  return {
    ...content,
    releases: boundedReleases(content.releases ?? [])
  };
}

export class LegacyContentError extends Error {}

// Legacy bodies bypassed today's schema. Bound the collection and tag work
// before semver sorting, while retaining support for partial historical content.
function boundedReleases(value: unknown): Release[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (release) =>
        !release ||
        typeof release !== "object" ||
        typeof release.tag !== "string" ||
        Array.from(release.tag).length > 100
    )
  )
    throw new LegacyContentError(
      "Legacy release collection exceeds safe read bounds"
    );
  return sortReleasesDescending(value as Release[]);
}

export function oversizedContent(): DatabaseResult<never> {
  return {
    data: null,
    error: {
      code: "CONTENT_UNAVAILABLE",
      message:
        "Legacy content exceeds safe read bounds; resubmit or export it administratively"
    }
  };
}
