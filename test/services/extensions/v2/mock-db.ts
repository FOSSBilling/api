type Row = Record<string, unknown>;

export interface MockTables {
  authors: Map<string, Row>;
  extensions: Map<string, Row>;
  extension_submissions: Map<string, Row>;
  users: Map<string, Row>;
}

export function createTables(): MockTables {
  return {
    authors: new Map(),
    extensions: new Map(),
    extension_submissions: new Map(),
    users: new Map()
  };
}

function ok<T = Record<string, unknown>>(results: T[] = []): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      last_row_id: 0,
      changes: results.length,
      served_by: "mock",
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      changed_db: false
    }
  };
}

class MockStatement implements D1PreparedStatement {
  private params: unknown[] = [];

  constructor(
    private tables: MockTables,
    private query: string
  ) {}

  bind(...params: unknown[]): D1PreparedStatement {
    this.params = params;
    return this;
  }

  raw: D1PreparedStatement["raw"] = (() => {
    throw new Error("not implemented");
  }) as D1PreparedStatement["raw"];

  private execute(): Row[] {
    const q = this.query.replace(/\s+/g, " ").trim();
    const p = this.params;

    // v1's SELECT_EXTENSIONS join (database.ts), for cross-service verification
    // that an approved v2 submission is visible via the v1 read path.
    if (q.startsWith("SELECT e.id, e.type, e.author_id,")) {
      let rows = [...this.tables.extensions.values()];
      if (q.includes("WHERE e.type = ?")) {
        rows = rows.filter((r) => r.type === p[0]);
      } else if (q.includes("WHERE LOWER(e.id) = LOWER(?)")) {
        const id = String(p[0]).toLowerCase();
        rows = rows.filter((r) => String(r.id).toLowerCase() === id);
      }
      return rows.map((r) => {
        const author = this.tables.authors.get(String(r.author_id));
        return {
          id: r.id,
          type: r.type,
          author_id: r.author_id,
          author_type: author?.type ?? "user",
          author_name: author?.name ?? "",
          author_url: author?.url ?? null,
          name: r.name,
          description: r.description,
          releases: r.releases,
          website: r.website,
          license: r.license,
          icon_url: r.icon_url,
          readme: r.readme,
          source: r.source,
          version: r.version,
          download_url: r.download_url
        };
      });
    }

    if (
      q.startsWith(
        "SELECT id, author_id FROM extensions WHERE LOWER(id) = LOWER(?)"
      )
    ) {
      const id = String(p[0]).toLowerCase();
      const row = [...this.tables.extensions.values()].find(
        (r) => String(r.id).toLowerCase() === id
      );
      return row ? [row] : [];
    }

    if (q.startsWith("SELECT owner_user_id FROM authors WHERE id = ?")) {
      const row = this.tables.authors.get(String(p[0]));
      return row ? [row] : [];
    }

    if (q.startsWith("SELECT is_moderator FROM users WHERE id = ?")) {
      const row = this.tables.users.get(String(p[0]));
      return row ? [row] : [];
    }

    if (
      q.startsWith(
        "INSERT INTO extension_submissions (id, extension_id, author_id, submitted_by, status, payload)"
      )
    ) {
      const [id, extension_id, author_id, submitted_by, payload] = p;
      this.tables.extension_submissions.set(String(id), {
        id,
        extension_id,
        author_id,
        submitted_by,
        status: "pending",
        payload,
        reviewer_id: null,
        review_note: null,
        created_at: new Date().toISOString(),
        reviewed_at: null
      });
      return [];
    }

    if (
      q.startsWith("SELECT * FROM extension_submissions WHERE submitted_by = ?")
    ) {
      return [...this.tables.extension_submissions.values()]
        .filter((r) => r.submitted_by === p[0])
        .sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at))
        );
    }

    if (q.startsWith("SELECT * FROM extension_submissions WHERE status = ?")) {
      return [...this.tables.extension_submissions.values()]
        .filter((r) => r.status === p[0])
        .sort((a, b) =>
          String(a.created_at).localeCompare(String(b.created_at))
        );
    }

    if (q.startsWith("SELECT * FROM extension_submissions WHERE id = ?")) {
      const row = this.tables.extension_submissions.get(String(p[0]));
      return row ? [row] : [];
    }

    if (q.startsWith("UPDATE extension_submissions SET status = 'rejected'")) {
      const [reviewer_id, review_note, id] = p;
      const row = this.tables.extension_submissions.get(String(id));
      if (row) {
        row.status = "rejected";
        row.reviewer_id = reviewer_id;
        row.review_note = review_note;
        row.reviewed_at = new Date().toISOString();
      }
      return [];
    }

    if (q.startsWith("UPDATE extension_submissions SET status = 'approved'")) {
      const [reviewer_id, review_note, id] = p;
      const row = this.tables.extension_submissions.get(String(id));
      if (row) {
        row.status = "approved";
        row.reviewer_id = reviewer_id;
        row.review_note = review_note;
        row.reviewed_at = new Date().toISOString();
      }
      return [];
    }

    if (
      q.startsWith("INSERT INTO authors (id, type, name, url, owner_user_id)")
    ) {
      const [id, type, name, url, owner_user_id] = p;
      const existing = this.tables.authors.get(String(id));
      this.tables.authors.set(String(id), {
        id,
        type,
        name,
        url,
        owner_user_id: existing ? existing.owner_user_id : owner_user_id
      });
      return [];
    }

    if (
      q.startsWith(
        "INSERT INTO extensions (id, type, author_id, name, description, releases, website, license, icon_url, readme, source, version, download_url)"
      )
    ) {
      const [
        id,
        type,
        author_id,
        name,
        description,
        releases,
        website,
        license,
        icon_url,
        readme,
        source,
        version,
        download_url
      ] = p;
      this.tables.extensions.set(String(id), {
        id,
        type,
        author_id,
        name,
        description,
        releases,
        website,
        license,
        icon_url,
        readme,
        source,
        version,
        download_url
      });
      return [];
    }

    throw new Error(`MockStatement: unhandled query: ${q}`);
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return ok(this.execute() as unknown as T[]);
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const rows = this.execute();
    if (rows.length === 0) return null;
    if (column) return (rows[0][column] as T) ?? null;
    return rows[0] as unknown as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.execute();
    return ok([]);
  }
}

export function createMockD1(tables: MockTables): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      return new MockStatement(tables, query);
    },

    dump(): Promise<ArrayBuffer> {
      throw new Error("not implemented");
    },

    async batch<T = unknown>(
      statements: D1PreparedStatement[]
    ): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        results.push(await stmt.run<T>());
      }
      return results;
    },

    exec(_query: string): Promise<D1ExecResult> {
      throw new Error("not implemented");
    },

    withSession(_constraintOrBookmark?: string): D1DatabaseSession {
      throw new Error("not implemented");
    }
  };
}
