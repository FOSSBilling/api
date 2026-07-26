type Row = Record<string, unknown>;

export interface MockTables {
  authors: Map<string, Row>;
  extensions: Map<string, Row>;
  extension_submissions: Map<string, Row>;
  author_history: Map<string, Row>;
  author_transfers: Map<string, Row>;
  author_claims: Map<string, Row>;
  users: Map<string, Row>;
  // Test-only seam for simulating a write-through failure during approve().
  forceExtensionWriteFailure?: boolean;
}

export function createTables(): MockTables {
  return {
    authors: new Map(),
    extensions: new Map(),
    extension_submissions: new Map(),
    author_history: new Map(),
    author_transfers: new Map(),
    author_claims: new Map(),
    users: new Map()
  };
}

function ok<T = Record<string, unknown>>(
  results: T[] = [],
  changes = results.length
): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      last_row_id: 0,
      changes,
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
  private changes = 0;

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

  get normalizedQuery(): string {
    return this.query.replace(/\s+/g, " ").trim();
  }

  private execute(): Row[] {
    const q = this.normalizedQuery;
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

    if (q.startsWith("SELECT * FROM authors WHERE owner_user_id = ?")) {
      const row = [...this.tables.authors.values()].find(
        (r) => r.owner_user_id === p[0]
      );
      return row ? [row] : [];
    }

    if (q.startsWith("SELECT * FROM authors WHERE id = ?")) {
      const row = this.tables.authors.get(String(p[0]));
      return row ? [row] : [];
    }

    if (q.startsWith("SELECT * FROM authors ORDER BY name")) {
      return [...this.tables.authors.values()].sort((a, b) =>
        String(a.name ?? "").localeCompare(String(b.name ?? ""))
      );
    }

    if (q.startsWith("SELECT * FROM authors WHERE approved_at IS NULL")) {
      return [...this.tables.authors.values()]
        .filter((r) => (r.approved_at ?? null) === null)
        .sort((a, b) =>
          String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))
        );
    }

    if (
      q.startsWith(
        "INSERT INTO authors (id, type, name, url, bio, avatar_url, contact_email, owner_user_id, approved_at, created_at, updated_at)"
      )
    ) {
      const [
        id,
        type,
        name,
        url,
        bio,
        avatar_url,
        contact_email,
        owner_user_id
      ] = p;
      // Mirrors idx_authors_owner_unique: one profile per non-null owner.
      const ownerTaken = [...this.tables.authors.values()].some(
        (r) => owner_user_id !== null && r.owner_user_id === owner_user_id
      );
      if (ownerTaken) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: authors.owner_user_id"
        );
      }
      const now = new Date().toISOString();
      this.tables.authors.set(String(id), {
        id,
        type,
        name,
        url,
        bio,
        avatar_url,
        contact_email,
        owner_user_id,
        approved_at: null,
        created_at: now,
        updated_at: now
      });
      return [];
    }

    if (
      q.startsWith(
        "UPDATE authors SET type = ?, name = ?, url = ?, bio = ?, avatar_url = ?, contact_email = ?, approved_at = NULL"
      )
    ) {
      const [type, name, url, bio, avatar_url, contact_email, id] = p;
      const row = this.tables.authors.get(String(id));
      if (row) {
        row.type = type;
        row.name = name;
        row.url = url;
        row.bio = bio;
        row.avatar_url = avatar_url;
        row.contact_email = contact_email;
        row.approved_at = null;
        row.updated_at = new Date().toISOString();
        this.changes = 1;
      }
      return [];
    }

    if (
      q.startsWith(
        "INSERT INTO author_history (id, author_id, type, name, url, changed_by, changed_at)"
      )
    ) {
      const [id, author_id, type, name, url, changed_by] = p;
      this.tables.author_history.set(String(id), {
        id,
        author_id,
        type,
        name,
        url,
        changed_by,
        changed_at: new Date().toISOString()
      });
      return [];
    }

    if (
      q.startsWith(
        "SELECT author_id, type, name, url, changed_by, changed_at FROM author_history WHERE author_id = ?"
      )
    ) {
      const [author_id] = p;
      // Newest-first, with ties (same-second CURRENT_TIMESTAMP) broken by
      // insertion order — mirrors the real query's `changed_at DESC, rowid DESC`.
      return [...this.tables.author_history.values()]
        .filter((r) => r.author_id === author_id)
        .reverse()
        .sort((a, b) =>
          String(b.changed_at).localeCompare(String(a.changed_at))
        );
    }

    if (
      q.startsWith(
        "UPDATE author_transfers SET revoked_at = CURRENT_TIMESTAMP WHERE author_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND EXISTS"
      )
    ) {
      const [author_id, owner_user_id] = p;
      const author = this.tables.authors.get(String(author_id));
      let changes = 0;
      if (author?.owner_user_id === owner_user_id) {
        for (const row of this.tables.author_transfers.values()) {
          if (
            row.author_id === author_id &&
            row.accepted_at === null &&
            row.revoked_at === null
          ) {
            row.revoked_at = new Date().toISOString();
            changes++;
          }
        }
      }
      this.changes = changes;
      return [];
    }

    if (
      q.startsWith(
        "INSERT INTO author_transfers (id, author_id, token_hash, created_by, expires_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS"
      )
    ) {
      const [
        id,
        author_id,
        token_hash,
        created_by,
        expires_at,
        checkAuthorId,
        owner_user_id
      ] = p;
      const author = this.tables.authors.get(String(checkAuthorId));
      if (author?.owner_user_id === owner_user_id) {
        this.tables.author_transfers.set(String(id), {
          id,
          author_id,
          token_hash,
          created_by,
          created_at: new Date().toISOString(),
          expires_at,
          accepted_by: null,
          accepted_at: null,
          revoked_at: null
        });
        this.changes = 1;
      } else {
        this.changes = 0;
      }
      return [];
    }

    if (
      q.startsWith(
        "UPDATE author_transfers SET accepted_at = CURRENT_TIMESTAMP, accepted_by = ? WHERE token_hash = ?"
      )
    ) {
      const [accepted_by, token_hash, owner_user_id] = p;
      const now = new Date();
      const ownsAny = [...this.tables.authors.values()].some(
        (r) => r.owner_user_id === owner_user_id
      );
      const row = [...this.tables.author_transfers.values()].find(
        (r) =>
          r.token_hash === token_hash &&
          r.accepted_at === null &&
          r.revoked_at === null &&
          new Date(`${String(r.expires_at).replace(" ", "T")}Z`) > now
      );
      if (row && !ownsAny) {
        row.accepted_at = new Date().toISOString();
        row.accepted_by = accepted_by;
        this.changes = 1;
      } else {
        this.changes = 0;
      }
      return [];
    }

    if (
      q.startsWith(
        "SELECT 1 FROM author_transfers WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP"
      )
    ) {
      const [token_hash] = p;
      const now = new Date();
      const row = [...this.tables.author_transfers.values()].find(
        (r) =>
          r.token_hash === token_hash &&
          r.accepted_at === null &&
          r.revoked_at === null &&
          new Date(`${String(r.expires_at).replace(" ", "T")}Z`) > now
      );
      return row ? [{ "1": 1 }] : [];
    }

    if (
      q.startsWith(
        "SELECT author_id FROM author_transfers WHERE token_hash = ?"
      )
    ) {
      const [token_hash] = p;
      const row = [...this.tables.author_transfers.values()].find(
        (r) => r.token_hash === token_hash
      );
      return row ? [{ author_id: row.author_id }] : [];
    }

    if (
      q.startsWith(
        "UPDATE authors SET owner_user_id = ?, approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE changes() = 1 AND id = ( SELECT author_id FROM author_transfers"
      )
    ) {
      const [owner_user_id, token_hash, accepted_by] = p;
      const transfer = [...this.tables.author_transfers.values()].find(
        (r) =>
          r.token_hash === token_hash &&
          r.accepted_by === accepted_by &&
          r.accepted_at !== null
      );
      const row = transfer
        ? this.tables.authors.get(String(transfer.author_id))
        : undefined;
      if (row) {
        row.owner_user_id = owner_user_id;
        row.approved_at = null;
        row.updated_at = new Date().toISOString();
        this.changes = 1;
      } else {
        this.changes = 0;
      }
      return [];
    }

    if (
      q.startsWith(
        "UPDATE authors SET approved_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
    ) {
      const [id] = p;
      const row = this.tables.authors.get(String(id));
      if (row) {
        row.approved_at = new Date().toISOString();
        this.changes = 1;
      }
      return [];
    }

    if (q.startsWith("SELECT 1 FROM authors WHERE owner_user_id = ?")) {
      const row = [...this.tables.authors.values()].find(
        (r) => r.owner_user_id === p[0]
      );
      return row ? [{ "1": 1 }] : [];
    }

    if (
      q.startsWith(
        "INSERT INTO author_claims (id, author_id, claimant_id, note) VALUES (?, ?, ?, ?)"
      )
    ) {
      const [id, author_id, claimant_id, note] = p;
      const pendingExists = [...this.tables.author_claims.values()].some(
        (r) =>
          r.author_id === author_id &&
          r.claimant_id === claimant_id &&
          r.status === "pending"
      );
      if (pendingExists) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: author_claims.author_id, author_claims.claimant_id"
        );
      }
      const now = new Date().toISOString();
      this.tables.author_claims.set(String(id), {
        id,
        author_id,
        claimant_id,
        status: "pending",
        note,
        review_note: null,
        reviewer_id: null,
        created_at: now,
        reviewed_at: null
      });
      return [];
    }

    if (q.startsWith("SELECT * FROM author_claims WHERE id = ?")) {
      const row = this.tables.author_claims.get(String(p[0]));
      return row ? [row] : [];
    }

    if (
      q.startsWith(
        "SELECT * FROM author_claims WHERE claimant_id = ? ORDER BY created_at DESC"
      )
    ) {
      return [...this.tables.author_claims.values()]
        .filter((r) => r.claimant_id === p[0])
        .sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at))
        );
    }

    if (
      q.startsWith("SELECT c.*, a.name AS author_name, a.type AS author_type")
    ) {
      return [...this.tables.author_claims.values()]
        .filter((r) => r.status === "pending")
        .sort((a, b) =>
          String(a.created_at).localeCompare(String(b.created_at))
        )
        .map((r) => {
          const author = this.tables.authors.get(String(r.author_id));
          return {
            ...r,
            author_name: author?.name ?? "",
            author_type: author?.type ?? "user"
          };
        });
    }

    if (
      q.startsWith(
        "UPDATE author_claims SET status = 'approved', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
      )
    ) {
      const [reviewer_id, id] = p;
      const row = this.tables.author_claims.get(String(id));
      if (row && row.status === "pending") {
        row.status = "approved";
        row.reviewer_id = reviewer_id;
        row.reviewed_at = new Date().toISOString();
        this.changes = 1;
      } else {
        this.changes = 0;
      }
      return [];
    }

    if (
      q.startsWith(
        "UPDATE authors SET owner_user_id = ?, approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
    ) {
      const [owner_user_id, id] = p;
      const row = this.tables.authors.get(String(id));
      if (row) {
        row.owner_user_id = owner_user_id;
        row.approved_at = null;
        row.updated_at = new Date().toISOString();
        this.changes = 1;
      } else {
        this.changes = 0;
      }
      return [];
    }

    if (
      q.startsWith(
        "UPDATE author_claims SET status = 'rejected', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = 'Another claim on this profile was approved' WHERE author_id = ?"
      )
    ) {
      const [reviewer_id, author_id, excludeId] = p;
      const now = new Date().toISOString();
      for (const row of this.tables.author_claims.values()) {
        if (
          row.author_id === author_id &&
          row.status === "pending" &&
          row.id !== excludeId
        ) {
          row.status = "rejected";
          row.reviewer_id = reviewer_id;
          row.reviewed_at = now;
          row.review_note = "Another claim on this profile was approved";
        }
      }
      return [];
    }

    if (
      q.startsWith(
        "UPDATE author_claims SET status = 'pending', reviewer_id = NULL, reviewed_at = NULL WHERE id = ?"
      )
    ) {
      const [id] = p;
      const row = this.tables.author_claims.get(String(id));
      if (row) {
        row.status = "pending";
        row.reviewer_id = null;
        row.reviewed_at = null;
      }
      return [];
    }

    if (
      q.startsWith(
        "UPDATE author_claims SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
      )
    ) {
      const [reviewer_id, review_note, id] = p;
      const row = this.tables.author_claims.get(String(id));
      if (row && row.status === "pending") {
        row.status = "rejected";
        row.reviewer_id = reviewer_id;
        row.review_note = review_note;
        row.reviewed_at = new Date().toISOString();
        this.changes = 1;
      } else {
        this.changes = 0;
      }
      return [];
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
      if (row && row.status === "pending") {
        row.status = "rejected";
        row.reviewer_id = reviewer_id;
        row.review_note = review_note;
        row.reviewed_at = new Date().toISOString();
        this.changes = 1;
      }
      return [];
    }

    if (q.startsWith("UPDATE extension_submissions SET status = 'approved'")) {
      const [reviewer_id, review_note, id] = p;
      const row = this.tables.extension_submissions.get(String(id));
      if (row && row.status === "pending") {
        row.status = "approved";
        row.reviewer_id = reviewer_id;
        row.review_note = review_note;
        row.reviewed_at = new Date().toISOString();
        this.changes = 1;
      }
      return [];
    }

    if (q.startsWith("UPDATE extension_submissions SET status = 'pending'")) {
      const [id] = p;
      const row = this.tables.extension_submissions.get(String(id));
      if (row) {
        row.status = "pending";
        row.reviewer_id = null;
        row.review_note = null;
        row.reviewed_at = null;
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
      if (this.tables.forceExtensionWriteFailure) {
        throw new Error("simulated write-through failure");
      }
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
    return ok<T>([], this.changes);
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
      // Mirrors SQL's changes(): the mock has no other way to expose "how
      // many rows did the immediately preceding statement change" across
      // statements, but acceptTransfer's ownership UPDATE deliberately
      // gates on changes() = 1 to prove the just-run claim actually fired
      // (rather than the token having been accepted at some point in the
      // past) — a statement referencing that gate is skipped here unless
      // the previous statement's change count was exactly 1.
      let lastChanges = 0;
      for (const stmt of statements) {
        const query = stmt instanceof MockStatement ? stmt.normalizedQuery : "";
        if (query.includes("WHERE changes() = 1") && lastChanges !== 1) {
          results.push(ok<T>([], 0));
          continue;
        }
        const result = await stmt.run<T>();
        lastChanges = result.meta?.changes ?? 0;
        results.push(result);
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
