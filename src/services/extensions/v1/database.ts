import { DatabaseResult, IDatabase } from "../../../lib/interfaces";
import { Extension, Release, Author, Repository, sortReleasesDescending } from "./interfaces";

export class ExtensionsDatabase {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  async getAllExtensions(type?: string): Promise<DatabaseResult<Extension[]>> {
    const query = type
      ? `SELECT * FROM extensions WHERE type = ?`
      : `SELECT * FROM extensions`;

    let result;
    try {
      const stmt = this.db.prepare(query);
      result = type
        ? await stmt.bind(type).all<Record<string, unknown>>()
        : await stmt.all<Record<string, unknown>>();
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "DATABASE_ERROR"
        }
      };
    }

    if (!result.success) {
      return {
        data: null,
        error: {
          message: result.error || "Database query failed",
          code: "DATABASE_ERROR"
        }
      };
    }

    const extensions = (result.results ?? []).map(parseExtensionRow);
    return { data: extensions, error: null };
  }

  async getExtensionById(id: string): Promise<DatabaseResult<Extension>> {
    const query = `SELECT * FROM extensions WHERE LOWER(id) = LOWER(?)`;

    let result;
    try {
      result = await this.db
        .prepare(query)
        .bind(id)
        .first<Record<string, unknown>>();
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: "DATABASE_ERROR"
        }
      };
    }

    if (!result) {
      return {
        data: null,
        error: {
          message: `Cannot find extension by id: ${id}`,
          code: "NOT_FOUND"
        }
      };
    }

    return { data: parseExtensionRow(result), error: null };
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
    author: parseJSON<Author>(row.author, {
      type: "user",
      name: "",
      id: "" as Lowercase<string>
    }),
    releases: sortReleasesDescending(releases),
    website: row.website as string,
    license: parseJSON(row.license, { name: "" }),
    icon_url: row.icon_url as string | undefined,
    readme: row.readme as string,
    source: parseJSON<Repository>(row.source, { type: "custom", repo: "" }),
    version: row.version as string,
    download_url: row.download_url as string
  };
}
