import { and, asc, eq, or, sql } from "drizzle-orm";
import { DatabaseResult } from "../../../lib/interfaces";
import { ExtensionsDb } from "../../../lib/db";
import { extensions, developers } from "./db/schema";
import { databaseError } from "./errors";
import {
  Extension,
  ExtensionListItem,
  License,
  Release,
  Repository,
  sortReleasesDescending,
  parseJSON
} from "./interfaces";

// LEFT JOIN so an extension whose developer row is missing (author_id
// pointing nowhere) still lists - author_id isn't a hard FK (see
// 0001_add_v2_tables.sql). COALESCE keeps developerId non-null in that
// case: extensions.authorId is itself NOT NULL, so the id half of the
// embedded developer is never lost even when every other field falls back
// to a default in parseExtensionRow below.
const EXTENSION_COLUMNS = {
  id: extensions.id,
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
  downloadUrl: extensions.downloadUrl,
  developerId: sql<string>`COALESCE(${developers.id}, ${extensions.authorId})`,
  developerType: developers.type,
  developerName: developers.name,
  developerUrl: developers.url,
  developerAvatarUrl: developers.avatarUrl,
  developerApprovedAt: developers.approvedAt
};

const EXTENSION_LIST_COLUMNS = {
  id: EXTENSION_COLUMNS.id,
  type: EXTENSION_COLUMNS.type,
  name: EXTENSION_COLUMNS.name,
  description: EXTENSION_COLUMNS.description,
  website: EXTENSION_COLUMNS.website,
  license: EXTENSION_COLUMNS.license,
  iconUrl: EXTENSION_COLUMNS.iconUrl,
  source: EXTENSION_COLUMNS.source,
  version: EXTENSION_COLUMNS.version,
  downloadUrl: EXTENSION_COLUMNS.downloadUrl,
  developerId: EXTENSION_COLUMNS.developerId,
  developerType: EXTENSION_COLUMNS.developerType,
  developerName: EXTENSION_COLUMNS.developerName,
  developerUrl: EXTENSION_COLUMNS.developerUrl,
  developerAvatarUrl: EXTENSION_COLUMNS.developerAvatarUrl,
  developerApprovedAt: EXTENSION_COLUMNS.developerApprovedAt
};

interface ExtensionRow {
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
  developerId: string;
  developerType: string | null;
  developerName: string | null;
  developerUrl: string | null;
  developerAvatarUrl: string | null;
  developerApprovedAt: string | null;
}

type ExtensionListRow = Omit<ExtensionRow, "readme" | "releases">;

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

interface ExtensionCursor {
  v: 1;
  normalizedId: string;
  id: string;
}

export class ExtensionsDatabase {
  constructor(private db: ExtensionsDb) {}

  async list(
    filters: ExtensionListFilters = {}
  ): Promise<DatabaseResult<ExtensionListPage>> {
    const limit = filters.limit ?? 50;
    const conditions = [];
    if (filters.type) conditions.push(eq(extensions.type, filters.type));
    if (filters.developerId)
      conditions.push(eq(extensions.authorId, filters.developerId));

    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor);
      if (!cursor) {
        return {
          data: null,
          error: {
            message: "Invalid pagination cursor",
            code: "INVALID_CURSOR"
          }
        };
      }
      conditions.push(
        or(
          sql`LOWER(${extensions.id}) > ${cursor.normalizedId}`,
          and(
            sql`LOWER(${extensions.id}) = ${cursor.normalizedId}`,
            sql`${extensions.id} > ${cursor.id}`
          )
        )!
      );
    }

    let rows: ExtensionListRow[];
    try {
      const query = this.db
        .select(EXTENSION_LIST_COLUMNS)
        .from(extensions)
        .leftJoin(developers, eq(extensions.authorId, developers.id));
      rows = await query
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(sql`LOWER(${extensions.id})`), asc(extensions.id))
        .limit(limit + 1);
    } catch (error) {
      return databaseError("list", error);
    }

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(parseExtensionListRow);
    const last = pageRows.at(-1);
    return {
      data: {
        items,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.id) : null
      },
      error: null
    };
  }

  async getById(id: string): Promise<DatabaseResult<Extension>> {
    let rows: ExtensionRow[];
    try {
      rows = await this.db
        .select(EXTENSION_COLUMNS)
        .from(extensions)
        .leftJoin(developers, eq(extensions.authorId, developers.id))
        .where(sql`LOWER(${extensions.id}) = LOWER(${id})`);
    } catch (error) {
      return databaseError("getById", error);
    }

    const row = rows[0];
    if (!row) {
      return {
        data: null,
        error: {
          message: `Cannot find extension by id: ${id}`,
          code: "NOT_FOUND"
        }
      };
    }

    return { data: parseExtensionRow(row), error: null };
  }
}

function encodeCursor(id: string): string {
  const cursor: ExtensionCursor = { v: 1, normalizedId: id.toLowerCase(), id };
<<<<<<< ours
  return btoa(JSON.stringify(cursor));
=======
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
>>>>>>> theirs
}

function decodeCursor(value: string): ExtensionCursor | null {
  try {
<<<<<<< ours
    const parsed: unknown = JSON.parse(atob(value));
=======
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0)
    );
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
    );
>>>>>>> theirs
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Partial<ExtensionCursor>).v !== 1 ||
      typeof (parsed as Partial<ExtensionCursor>).id !== "string" ||
      typeof (parsed as Partial<ExtensionCursor>).normalizedId !== "string" ||
      (parsed as ExtensionCursor).normalizedId !==
        (parsed as ExtensionCursor).id.toLowerCase()
    ) {
      return null;
    }
    return parsed as ExtensionCursor;
  } catch {
    return null;
  }
}

function parseExtensionRow(row: ExtensionRow): Extension {
  const releases = parseJSON<Release[]>(row.releases, []);
  return {
    id: row.id,
    type: row.type as Extension["type"],
    name: row.name,
    description: row.description,
    releases: sortReleasesDescending(releases),
    website: row.website,
    license: parseJSON<License>(row.license, { name: "" }),
    icon_url: row.iconUrl ?? undefined,
    readme: row.readme,
    source: parseJSON<Repository>(row.source, { type: "custom", repo: "" }),
    version: row.version,
    download_url: row.downloadUrl,
    developer: {
      id: row.developerId,
      type: (row.developerType as "user" | "organization") ?? "user",
      name: row.developerName ?? "",
      URL: row.developerUrl ?? undefined,
      avatar_url: row.developerAvatarUrl ?? undefined,
      approved: row.developerApprovedAt !== null
    }
  };
}

function parseExtensionListRow(row: ExtensionListRow): ExtensionListItem {
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
    developer: {
      id: row.developerId,
      type: (row.developerType as "user" | "organization") ?? "user",
      name: row.developerName ?? "",
      URL: row.developerUrl ?? undefined,
      avatar_url: row.developerAvatarUrl ?? undefined,
      approved: row.developerApprovedAt !== null
    }
  };
}
