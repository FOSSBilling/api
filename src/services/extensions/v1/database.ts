import { and, eq, isNotNull, sql } from "drizzle-orm";
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
  developerId: extensions.developerId,
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

// An inner join: extensions.developer_id is NOT NULL with an enforced foreign
// key, so the author* columns are as non-null as developers' own constraints
// make them.
//
// extensions' own content columns became nullable in migration 0021, where an
// extension row starts existing before it is published. They are still
// non-null here because both queries below filter on published_at IS NOT NULL
// and extensions_published_content_check makes that filter sufficient - a
// published row cannot be missing any of them. That filter is also what keeps
// unreviewed extensions out of the v1 catalogue.
interface ExtensionRow {
  id: string;
  type: string;
  developerId: string;
  authorType: string;
  authorName: string;
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
      const published = isNotNull(extensions.publishedAt);
      rows = (await this.db
        .select(EXTENSION_COLUMNS)
        .from(extensions)
        .innerJoin(developers, eq(extensions.developerId, developers.id))
        .where(
          type ? and(published, eq(extensions.type, type)) : published
        )) as ExtensionRow[];
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
      rows = (await this.db
        .select(EXTENSION_COLUMNS)
        .from(extensions)
        .innerJoin(developers, eq(extensions.developerId, developers.id))
        .where(
          and(
            sql`LOWER(${extensions.id}) = LOWER(${id})`,
            isNotNull(extensions.publishedAt)
          )
        )) as ExtensionRow[];
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
      type: row.authorType as "organization" | "user",
      name: row.authorName,
      id: row.developerId as Lowercase<string>,
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
