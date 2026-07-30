import { eq, sql } from "drizzle-orm";
import { ExtensionsDb } from "../../../lib/db";
import { extensions, developers } from "../v2/db/schema";
import { DatabaseResult } from "../../../lib/interfaces";
import {
  Extension,
  Release,
  Author,
  Repository,
  sortReleasesDescending,
  parseJSON
} from "./interfaces";

const EXTENSION_COLUMNS = {
  id: extensions.id,
  type: extensions.type,
  authorId: extensions.authorId,
  authorType: developers.type,
  authorName: developers.name,
  authorUrl: developers.url,
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

// A LEFT JOIN can produce no matching developers row, so every joined
// (author*) column is nullable regardless of developers' own NOT NULL
// constraints - only extensions' own columns (besides iconUrl) are
// guaranteed non-null.
interface ExtensionRow {
  id: string;
  type: string;
  authorId: string;
  authorType: string | null;
  authorName: string | null;
  authorUrl: string | null;
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

export class ExtensionsDatabase {
  constructor(private db: ExtensionsDb) {}

  async getAllExtensions(type?: string): Promise<DatabaseResult<Extension[]>> {
    let rows: ExtensionRow[];
    try {
      const query = this.db
        .select(EXTENSION_COLUMNS)
        .from(extensions)
        .leftJoin(developers, eq(extensions.authorId, developers.id));
      rows = type ? await query.where(eq(extensions.type, type)) : await query;
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "DATABASE_ERROR"
        }
      };
    }

    return { data: rows.map(parseExtensionRow), error: null };
  }

  async getExtensionById(id: string): Promise<DatabaseResult<Extension>> {
    let rows: ExtensionRow[];
    try {
      rows = await this.db
        .select(EXTENSION_COLUMNS)
        .from(extensions)
        .leftJoin(developers, eq(extensions.authorId, developers.id))
        .where(sql`LOWER(${extensions.id}) = LOWER(${id})`);
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "DATABASE_ERROR"
        }
      };
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

function parseExtensionRow(row: ExtensionRow): Extension {
  const releases = parseJSON<Release[]>(row.releases, []);
  return {
    id: row.id,
    type: row.type as Extension["type"],
    name: row.name,
    description: row.description,
    author: {
      type: (row.authorType as "organization" | "user") ?? "user",
      name: row.authorName ?? "",
      id: (row.authorId as Lowercase<string>) ?? ("" as Lowercase<string>),
      URL: row.authorUrl ?? undefined
    } as Author,
    releases: sortReleasesDescending(releases),
    website: row.website,
    license: parseJSON(row.license, { name: "" }),
    icon_url: row.iconUrl ?? undefined,
    readme: row.readme,
    source: parseJSON<Repository>(row.source, { type: "custom", repo: "" }),
    version: row.version,
    download_url: row.downloadUrl
  };
}
