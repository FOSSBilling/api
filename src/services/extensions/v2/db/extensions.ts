import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { DatabaseResult } from "../../../../lib/interfaces";
import { ExtensionsDb } from "../../../../lib/db";
import { sortReleasesDescending } from "../../../../lib/releases";
import { parseJSON } from "../../../../lib/json";
import { extensions, extensionRevisions, developers } from "./schema";
import { databaseError } from "./errors";
import { toD1Statement } from "./batch";
import { encodeCursor as encode, decodeCursor as decode } from "./cursor";
import {
  Extension,
  ExtensionContent,
  ExtensionListItem,
  License,
  OwnedExtension,
  OwnedExtensionListItem,
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
  developerOwnerUserId: developers.ownerUserId
};

const CONTENT_COLUMNS = {
  type: extensions.type,
  name: extensions.name,
  description: extensions.description,
  releases: extensions.releases,
  website: extensions.website,
  license: extensions.license,
  iconUrl: extensions.iconUrl,
  readme: extensions.readme,
  source: extensions.source,
  version: extensions.version,
  downloadUrl: extensions.downloadUrl
};

const EXTENSION_COLUMNS = {
  id: extensions.id,
  ...CONTENT_COLUMNS,
  ...DEVELOPER_COLUMNS
};

// Derived by subtraction so a column added to CONTENT_COLUMNS cannot be
// forgotten here: catalogue cards omit only the two large fields.
const {
  readme: _readme,
  releases: _releases,
  ...EXTENSION_LIST_COLUMNS
} = EXTENSION_COLUMNS;

// The owner view joins extension_revisions twice: once for the unreviewed
// edit (at most one - idx_extension_revisions_pending), once for the most
// recent decision. "Most recently reviewed" is not expressible as a join
// predicate, so that side matches on a correlated subquery instead.
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
    ORDER BY r.reviewed_at DESC, r.id DESC
    LIMIT 1
  )`
);

const REVIEW_COLUMNS = {
  pendingId: PENDING.id,
  pendingCreatedAt: PENDING.createdAt,
  reviewedId: REVIEWED.id,
  reviewedStatus: REVIEWED.status,
  reviewedNote: REVIEWED.reviewNote,
  reviewedAt: REVIEWED.reviewedAt
};

const {
  readme: _ownedReadme,
  releases: _ownedReleases,
  ...CARD_CONTENT_COLUMNS
} = CONTENT_COLUMNS;

// The owner list drops the same two large published fields the catalogue does,
// and the pending revision's stored content (up to 256 KiB per row) with it.
const OWNED_LIST_COLUMNS = {
  id: extensions.id,
  publishedAt: extensions.publishedAt,
  createdAt: extensions.createdAt,
  updatedAt: extensions.updatedAt,
  ...CARD_CONTENT_COLUMNS,
  ...DEVELOPER_COLUMNS,
  ...REVIEW_COLUMNS
};

const OWNED_COLUMNS = {
  ...OWNED_LIST_COLUMNS,
  readme: extensions.readme,
  releases: extensions.releases,
  pendingContent: PENDING.content
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
}

type PublishedListRow = Omit<PublishedRow, "readme" | "releases">;

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
    const conditions = [isNotNull(extensions.publishedAt)];
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
        items: pageRows.map(parseListRow),
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
            isNotNull(extensions.publishedAt)
          )
        )) as PublishedRow[];
    } catch (error) {
      return databaseError("getById", error);
    }

    const row = rows[0];
    if (!row) return notFound(id);
    return { data: parseRow(row), error: null };
  }

  async listOwned(filters: {
    developerId: string;
    type?: string;
    limit?: number;
    cursor?: string;
  }): Promise<DatabaseResult<OwnedExtensionListPage>> {
    const limit = filters.limit ?? 50;
    const conditions = [eq(extensions.developerId, filters.developerId)];
    if (filters.type) conditions.push(eq(extensions.type, filters.type));
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
    return {
      data: {
        extension: parseOwnedRow(row),
        ownerUserId: row.developerOwnerUserId
      },
      error: null
    };
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
        sql: `INSERT INTO extensions (id, developer_id, created_at, updated_at)
              SELECT ?, d.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
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
      return databaseError("create", error);
    }

    if (!results[0]?.meta?.changes) {
      try {
        return { data: null, error: await this.createBlockedError(input) };
      } catch (error) {
        return databaseError("create", error);
      }
    }

    return { data: { id: input.extensionId, revisionId }, error: null };
  }

  // The insert affected no rows: either ON CONFLICT DO NOTHING swallowed an id
  // collision, or the WHERE guard rejected the caller. Only the first has a
  // specific message, so look for the row that would have caused it.
  private async createBlockedError(
    input: CreateExtensionInput
  ): Promise<{ message: string; code: string }> {
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
        WHERE id = ${id}
          AND published_at IS NULL
          AND developer_id IN (
            SELECT d.id FROM ${developers} d WHERE d.owner_user_id = ${ownerUserId}
          )
      `);
    } catch (error) {
      return databaseError("withdraw", error);
    }

    if (!result.meta?.changes) {
      const [existing] = await this.db
        .select({ publishedAt: extensions.publishedAt })
        .from(extensions)
        .where(eq(extensions.id, id));
      if (!existing) return notFound(id);
      return {
        data: null,
        error: existing.publishedAt
          ? {
              message: "A published extension cannot be withdrawn",
              code: "CONFLICT"
            }
          : { message: "You do not own this extension", code: "FORBIDDEN" }
      };
    }

    return { data: { id }, error: null };
  }
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
    approved: row.developerApprovedAt !== null,
    unclaimed: row.developerOwnerUserId === null
  };
}

// Shared by both parsers so the catalogue card and the detail view can never
// disagree about the embedded developer.
function parseListRow(row: PublishedListRow): ExtensionListItem {
  return {
    id: row.id,
    type: row.type as ExtensionListItem["type"],
    name: row.name,
    description: row.description,
    website: row.website,
    license: parseJSON<License>(row.license, { name: "" }),
    icon_url: row.iconUrl ?? undefined,
    source: parseJSON<Repository>(row.source, { type: "custom", repo: "" }),
    version: row.version,
    download_url: row.downloadUrl,
    developer: parseDeveloper(row)
  };
}

// The detail view is the list projection plus the two large fields the
// catalogue query deliberately omits.
function parseRow(row: PublishedRow): Extension {
  return {
    ...parseListRow(row),
    readme: row.readme,
    releases: sortReleasesDescending(parseJSON<Release[]>(row.releases, []))
  };
}

// Only ever called for a row whose published_at is set, where
// extensions_published_content_check guarantees each of these is present.
function publishedContent(
  row: OwnedListRow
): Omit<ExtensionContent, "readme" | "releases"> {
  return {
    type: row.type as ExtensionContent["type"],
    name: row.name as string,
    description: row.description as string,
    website: row.website as string,
    license: parseJSON<License>(row.license as string, { name: "" }),
    icon_url: row.iconUrl ?? undefined,
    source: parseJSON<Repository>(row.source as string, {
      type: "custom",
      repo: ""
    }),
    version: row.version as string,
    download_url: row.downloadUrl as string
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
    created_at: row.createdAt,
    updated_at: row.updatedAt
  };
}

function parseOwnedRow(row: OwnedRow): OwnedExtension {
  return {
    ...parseOwnedListRow(row),
    published: row.publishedAt
      ? {
          ...publishedContent(row),
          readme: row.readme as string,
          releases: sortReleasesDescending(
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
export function parseContent(stored: string | null): ExtensionContent {
  const content = parseJSON<ExtensionContent>(
    stored ?? "",
    {} as ExtensionContent
  );
  return {
    ...content,
    releases: sortReleasesDescending(content.releases ?? [])
  };
}
