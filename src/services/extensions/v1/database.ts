import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
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
// unreviewed extensions out of the v1 catalogue. delisted_at IS NULL is the
// other half: v1 shares this table with v2's public catalogue and must stay
// in sync with what v2 hides, or a moderator delisting an extension would
// pull it from the v2 catalogue while it stayed visible here.
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

  // page (when given) bounds the query with a limit+1 probe - the extra
  // row only answers has_more and is trimmed off. Omitted => every
  // published extension, unchanged from the original contract. The full
  // projection is deliberate: this legacy surface is a documented contract
  // and its consumers read readme/releases on every entry.
  async getAllExtensions(
    type?: string,
    page?: { limit: number; offset: number }
  ): Promise<DatabaseResult<{ extensions: Extension[]; hasMore: boolean }>> {
    let rows: ExtensionRow[];
    try {
      const published = and(
        isNotNull(extensions.publishedAt),
        isNull(extensions.delistedAt)
      );
      const base = this.db
        .select(EXTENSION_COLUMNS)
        .from(extensions)
        .innerJoin(developers, eq(extensions.developerId, developers.id))
        .where(type ? and(published, eq(extensions.type, type)) : published);
      // Offset pagination needs a deterministic order (the unpaginated
      // default deliberately stays unordered) - (LOWER(id), id) matches
      // the published-catalogue index and is unique.
      rows = page
        ? ((await base
            .orderBy(sql`LOWER(${extensions.id})`, extensions.id)
            .offset(page.offset)
            .limit(page.limit + 1)) as ExtensionRow[])
        : ((await base) as ExtensionRow[]);
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "DATABASE_ERROR"
        }
      };
    }

    const hasMore = page ? rows.length > page.limit : false;
    const trimmed = page && hasMore ? rows.slice(0, page.limit) : rows;

    return {
      data: { extensions: trimmed.map(parseExtensionRow), hasMore },
      error: null
    };
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
            isNotNull(extensions.publishedAt),
            isNull(extensions.delistedAt)
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

  // Badge/version endpoints read only these two columns, and badges are the
  // highest-volume path in this service (README embeds + crawlers) - selecting
  // the full projection would ship every row's readme blob to render a
  // few-hundred-byte SVG.
  async getExtensionBadgeData(
    id: string
  ): Promise<
    DatabaseResult<{ latestRelease: Release | null; license: { name: string } }>
  > {
    let rows: { releases: string; license: string }[];
    try {
      rows = (await this.db
        .select({ releases: extensions.releases, license: extensions.license })
        .from(extensions)
        .where(
          and(
            sql`LOWER(${extensions.id}) = LOWER(${id})`,
            isNotNull(extensions.publishedAt),
            isNull(extensions.delistedAt)
          )
        )) as { releases: string; license: string }[];
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

    const releases = sortReleasesDescending(
      parseJSON<Release[]>(row.releases, [])
    );
    return {
      data: {
        latestRelease: releases[0] ?? null,
        license: parseJSON(row.license, { name: "" })
      },
      error: null
    };
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
