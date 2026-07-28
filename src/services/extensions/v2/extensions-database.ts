import { and, eq, sql } from "drizzle-orm";
import { DatabaseResult } from "../../../lib/interfaces";
import { ExtensionsDb } from "../../../lib/db";
import { extensions, developers } from "./db/schema";
import { databaseError } from "./errors";
import {
  Extension,
  License,
  Release,
  Repository,
  sortReleasesDescending
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

export interface ExtensionListFilters {
  type?: string;
  developerId?: string;
}

export class ExtensionsDatabase {
  constructor(private db: ExtensionsDb) {}

  async list(
    filters: ExtensionListFilters = {}
  ): Promise<DatabaseResult<Extension[]>> {
    const conditions = [];
    if (filters.type) conditions.push(eq(extensions.type, filters.type));
    if (filters.developerId)
      conditions.push(eq(extensions.authorId, filters.developerId));

    let rows: ExtensionRow[];
    try {
      const query = this.db
        .select(EXTENSION_COLUMNS)
        .from(extensions)
        .leftJoin(developers, eq(extensions.authorId, developers.id));
      rows = conditions.length ? await query.where(and(...conditions)) : await query;
    } catch (error) {
      return databaseError("list", error);
    }

    return { data: rows.map(parseExtensionRow), error: null };
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

function parseJSON<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value !== undefined && value !== null ? (value as T) : fallback;
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
