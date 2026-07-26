import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
import { databaseError } from "./errors";
import {
  Extension,
  License,
  Release,
  Repository,
  sortReleasesDescending
} from "./interfaces";

const SELECT_EXTENSIONS = `
  SELECT e.id, e.type, e.name, e.description, e.releases, e.website, e.license,
         e.icon_url, e.readme, e.source, e.version, e.download_url,
         d.id AS developer_id, d.type AS developer_type, d.name AS developer_name,
         d.url AS developer_url, d.bio AS developer_bio,
         d.avatar_url AS developer_avatar_url, d.approved_at AS developer_approved_at
  FROM extensions e
  LEFT JOIN developers d ON e.author_id = d.id
`;

export interface ExtensionListFilters {
  type?: string;
  developerId?: string;
}

export class ExtensionsDatabase {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  async list(
    filters: ExtensionListFilters = {}
  ): Promise<DatabaseResult<Extension[]>> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.type) {
      conditions.push("e.type = ?");
      params.push(filters.type);
    }
    if (filters.developerId) {
      conditions.push("e.author_id = ?");
      params.push(filters.developerId);
    }
    const query = conditions.length
      ? `${SELECT_EXTENSIONS} WHERE ${conditions.join(" AND ")}`
      : SELECT_EXTENSIONS;

    let result;
    try {
      result = await this.db
        .prepare(query)
        .bind(...params)
        .all<Record<string, unknown>>();
    } catch (error) {
      return databaseError("list", error);
    }

    if (!result.success) {
      return databaseError(
        "list",
        new Error(result.error || "Database query failed")
      );
    }

    return {
      data: (result.results ?? []).map(parseExtensionRow),
      error: null
    };
  }

  async getById(id: string): Promise<DatabaseResult<Extension>> {
    let row;
    try {
      row = await this.db
        .prepare(`${SELECT_EXTENSIONS} WHERE LOWER(e.id) = LOWER(?)`)
        .bind(id)
        .first<Record<string, unknown>>();
    } catch (error) {
      return databaseError("getById", error);
    }

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

function parseExtensionRow(row: Record<string, unknown>): Extension {
  const releases = parseJSON<Release[]>(row.releases, []);
  return {
    id: row.id as string,
    type: row.type as Extension["type"],
    name: row.name as string,
    description: row.description as string,
    releases: sortReleasesDescending(releases),
    website: row.website as string,
    license: parseJSON<License>(row.license, { name: "" }),
    icon_url: typeof row.icon_url === "string" ? row.icon_url : undefined,
    readme: row.readme as string,
    source: parseJSON<Repository>(row.source, { type: "custom", repo: "" }),
    version: row.version as string,
    download_url: row.download_url as string,
    developer: {
      id: row.developer_id as string,
      type: (row.developer_type as "user" | "organization") ?? "user",
      name: (row.developer_name as string) ?? "",
      URL:
        typeof row.developer_url === "string" ? row.developer_url : undefined,
      bio:
        typeof row.developer_bio === "string" ? row.developer_bio : undefined,
      avatar_url:
        typeof row.developer_avatar_url === "string"
          ? row.developer_avatar_url
          : undefined,
      approved:
        row.developer_approved_at !== null &&
        row.developer_approved_at !== undefined
    }
  };
}
