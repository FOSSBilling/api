type Row = Record<string, unknown>;

export interface MockTables {
  developers: Map<string, Row>;
  extensions: Map<string, Row>;
  extension_submissions: Map<string, Row>;
  developer_history: Map<string, Row>;
  developer_transfers: Map<string, Row>;
  developer_claims: Map<string, Row>;
  users: Map<string, Row>;
  // Test-only seam for simulating a write-through failure during approve().
  forceExtensionWriteFailure?: boolean;
  // Test-only seam for simulating a profile changing ownership in the
  // window between deleteOwn()'s initial lookup and its guarded delete —
  // fires (once) the first time that lookup runs, mutating the row so the
  // guard sees a different owner than the caller who's mid-request.
  raceOwnerChangeTo?: string;
}

export function createTables(): MockTables {
  return {
    developers: new Map(),
    extensions: new Map(),
    extension_submissions: new Map(),
    developer_history: new Map(),
    developer_transfers: new Map(),
    developer_claims: new Map(),
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

  private isEligibleForDeveloperDeletion(
    developerId: string,
    ownerUserId: unknown
  ): boolean {
    const developer = this.tables.developers.get(developerId);
    if (!developer || developer.owner_user_id !== ownerUserId) return false;
    const hasExtensions = [...this.tables.extensions.values()].some(
      (r) => r.author_id === developerId
    );
    if (hasExtensions) return false;
    const hasPendingSubmission = [
      ...this.tables.extension_submissions.values()
    ].some((r) => r.developer_id === developerId && r.status === "pending");
    return !hasPendingSubmission;
  }

  private execute(): Row[] {
    const q = this.normalizedQuery;
    const p = this.params;

    // v2's SELECT_EXTENSIONS join (extensions-database.ts): public
    // list/getById reads, with an optional WHERE for type / author_id /
    // case-insensitive id, applied in that order to match how the params
    // are bound.
    if (q.startsWith("SELECT e.id, e.type, e.name, e.description,")) {
      let rows = [...this.tables.extensions.values()];
      let paramIdx = 0;
      if (q.includes("e.type = ?")) {
        rows = rows.filter((r) => r.type === p[paramIdx]);
        paramIdx++;
      }
      if (q.includes("e.author_id = ?")) {
        rows = rows.filter((r) => r.author_id === p[paramIdx]);
        paramIdx++;
      }
      if (q.includes("LOWER(e.id) = LOWER(?)")) {
        const id = String(p[paramIdx]).toLowerCase();
        rows = rows.filter((r) => String(r.id).toLowerCase() === id);
        paramIdx++;
      }
      return rows.map((r) => {
        const developer = this.tables.developers.get(String(r.author_id));
        return {
          id: r.id,
          type: r.type,
          name: r.name,
          description: r.description,
          releases: r.releases,
          website: r.website,
          license: r.license,
          icon_url: r.icon_url,
          readme: r.readme,
          source: r.source,
          version: r.version,
          download_url: r.download_url,
          developer_id: developer?.id ?? r.author_id,
          developer_type: developer?.type ?? "user",
          developer_name: developer?.name ?? "",
          developer_url: developer?.url ?? null,
          developer_avatar_url: developer?.avatar_url ?? null,
          developer_approved_at: developer?.approved_at ?? null
        };
      });
    }

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
        const developer = this.tables.developers.get(String(r.author_id));
        return {
          id: r.id,
          type: r.type,
          author_id: r.author_id,
          author_type: developer?.type ?? "user",
          author_name: developer?.name ?? "",
          author_url: developer?.url ?? null,
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

    if (
      q.startsWith(
        "SELECT COUNT(*) AS count FROM extensions WHERE author_id = ?"
      )
    ) {
      const count = [...this.tables.extensions.values()].filter(
        (r) => r.author_id === p[0]
      ).length;
      return [{ count }];
    }

    if (
      q.startsWith(
        "SELECT COUNT(*) AS count FROM extension_submissions WHERE developer_id = ? AND status = 'pending'"
      )
    ) {
      const count = [...this.tables.extension_submissions.values()].filter(
        (r) => r.developer_id === p[0] && r.status === "pending"
      ).length;
      return [{ count }];
    }

    if (q.startsWith("SELECT owner_user_id FROM developers WHERE id = ?")) {
      const row = this.tables.developers.get(String(p[0]));
      return row ? [row] : [];
    }

    if (q.startsWith("SELECT id FROM developers WHERE owner_user_id = ?")) {
      const row = [...this.tables.developers.values()].find(
        (r) => r.owner_user_id === p[0]
      );
      if (row && this.tables.raceOwnerChangeTo !== undefined) {
        row.owner_user_id = this.tables.raceOwnerChangeTo;
        this.tables.raceOwnerChangeTo = undefined;
      }
      return row ? [{ id: row.id }] : [];
    }

    if (q.startsWith("SELECT * FROM developers WHERE owner_user_id = ?")) {
      const row = [...this.tables.developers.values()].find(
        (r) => r.owner_user_id === p[0]
      );
      return row ? [row] : [];
    }

    if (q.startsWith("SELECT * FROM developers WHERE id = ?")) {
      const row = this.tables.developers.get(String(p[0]));
      return row ? [row] : [];
    }

    if (q.startsWith("SELECT * FROM developers ORDER BY name")) {
      return [...this.tables.developers.values()].sort((a, b) =>
        String(a.name ?? "").localeCompare(String(b.name ?? ""))
      );
    }

    if (q.startsWith("SELECT * FROM developers WHERE approved_at IS NULL")) {
      return [...this.tables.developers.values()]
        .filter((r) => (r.approved_at ?? null) === null)
        .sort((a, b) =>
          String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))
        );
    }

    if (
      q.startsWith(
        "INSERT INTO developers (id, type, name, url, avatar_url, contact_email, owner_user_id, approved_at, created_at, updated_at)"
      )
    ) {
      const [
        id,
        type,
        name,
        url,
        avatar_url,
        contact_email,
        owner_user_id
      ] = p;
      // Mirrors idx_developers_owner_unique: one profile per non-null owner.
      const ownerTaken = [...this.tables.developers.values()].some(
        (r) => owner_user_id !== null && r.owner_user_id === owner_user_id
      );
      if (ownerTaken) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: developers.owner_user_id"
        );
      }
      const now = new Date().toISOString();
      this.tables.developers.set(String(id), {
        id,
        type,
        name,
        url,
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
        "UPDATE developers SET type = ?, name = ?, url = ?, avatar_url = ?, contact_email = ?, approved_at = NULL"
      )
    ) {
      const [type, name, url, avatar_url, contact_email, id] = p;
      const row = this.tables.developers.get(String(id));
      if (row) {
        row.type = type;
        row.name = name;
        row.url = url;
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
        "INSERT INTO developer_history (id, developer_id, type, name, url, changed_by, changed_at)"
      )
    ) {
      const [id, developer_id, type, name, url, changed_by] = p;
      this.tables.developer_history.set(String(id), {
        id,
        developer_id,
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
        "SELECT developer_id, type, name, url, changed_by, changed_at FROM developer_history WHERE developer_id = ?"
      )
    ) {
      const [developer_id] = p;
      // Newest-first, with ties (same-second CURRENT_TIMESTAMP) broken by
      // insertion order — mirrors the real query's `changed_at DESC, rowid DESC`.
      return [...this.tables.developer_history.values()]
        .filter((r) => r.developer_id === developer_id)
        .reverse()
        .sort((a, b) =>
          String(b.changed_at).localeCompare(String(a.changed_at))
        );
    }

    if (
      q.startsWith(
        "UPDATE developer_transfers SET revoked_at = CURRENT_TIMESTAMP WHERE developer_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND EXISTS"
      )
    ) {
      const [developer_id, owner_user_id] = p;
      const developer = this.tables.developers.get(String(developer_id));
      let changes = 0;
      if (developer?.owner_user_id === owner_user_id) {
        for (const row of this.tables.developer_transfers.values()) {
          if (
            row.developer_id === developer_id &&
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
        "INSERT INTO developer_transfers (id, developer_id, token_hash, created_by, expires_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS"
      )
    ) {
      const [
        id,
        developer_id,
        token_hash,
        created_by,
        expires_at,
        checkDeveloperId,
        owner_user_id
      ] = p;
      const developer = this.tables.developers.get(String(checkDeveloperId));
      if (developer?.owner_user_id === owner_user_id) {
        this.tables.developer_transfers.set(String(id), {
          id,
          developer_id,
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
        "UPDATE developer_transfers SET accepted_at = CURRENT_TIMESTAMP, accepted_by = ? WHERE token_hash = ?"
      )
    ) {
      const [accepted_by, token_hash, owner_user_id] = p;
      const now = new Date();
      const ownsAny = [...this.tables.developers.values()].some(
        (r) => r.owner_user_id === owner_user_id
      );
      const row = [...this.tables.developer_transfers.values()].find(
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
        "SELECT 1 FROM developer_transfers WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP"
      )
    ) {
      const [token_hash] = p;
      const now = new Date();
      const row = [...this.tables.developer_transfers.values()].find(
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
        "SELECT developer_id FROM developer_transfers WHERE token_hash = ?"
      )
    ) {
      const [token_hash] = p;
      const row = [...this.tables.developer_transfers.values()].find(
        (r) => r.token_hash === token_hash
      );
      return row ? [{ developer_id: row.developer_id }] : [];
    }

    if (
      q.startsWith(
        "UPDATE developers SET owner_user_id = ?, approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE changes() = 1 AND id = ( SELECT developer_id FROM developer_transfers"
      )
    ) {
      const [owner_user_id, token_hash, accepted_by] = p;
      const transfer = [...this.tables.developer_transfers.values()].find(
        (r) =>
          r.token_hash === token_hash &&
          r.accepted_by === accepted_by &&
          r.accepted_at !== null
      );
      const row = transfer
        ? this.tables.developers.get(String(transfer.developer_id))
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
        "UPDATE developers SET approved_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
    ) {
      const [id] = p;
      const row = this.tables.developers.get(String(id));
      if (row) {
        row.approved_at = new Date().toISOString();
        this.changes = 1;
      }
      return [];
    }

    if (q.startsWith("SELECT 1 FROM developers WHERE owner_user_id = ?")) {
      const row = [...this.tables.developers.values()].find(
        (r) => r.owner_user_id === p[0]
      );
      return row ? [{ "1": 1 }] : [];
    }

    if (
      q.startsWith(
        "INSERT INTO developer_claims (id, developer_id, claimant_id, note) SELECT ?, ?, ?, ? WHERE EXISTS"
      )
    ) {
      const [
        id,
        developer_id,
        claimant_id,
        note,
        checkDeveloperId,
        checkClaimantId
      ] = p;
      const developer = this.tables.developers.get(String(checkDeveloperId));
      const claimantOwnsAny = [...this.tables.developers.values()].some(
        (r) => r.owner_user_id === checkClaimantId
      );
      if (!developer || developer.owner_user_id !== null || claimantOwnsAny) {
        this.changes = 0;
        return [];
      }

      const pendingExists = [...this.tables.developer_claims.values()].some(
        (r) =>
          r.developer_id === developer_id &&
          r.claimant_id === claimant_id &&
          r.status === "pending"
      );
      if (pendingExists) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: developer_claims.developer_id, developer_claims.claimant_id"
        );
      }
      const now = new Date().toISOString();
      this.tables.developer_claims.set(String(id), {
        id,
        developer_id,
        claimant_id,
        status: "pending",
        note,
        review_note: null,
        reviewer_id: null,
        created_at: now,
        reviewed_at: null
      });
      this.changes = 1;
      return [];
    }

    if (q.startsWith("SELECT * FROM developer_claims WHERE id = ?")) {
      const row = this.tables.developer_claims.get(String(p[0]));
      return row ? [row] : [];
    }

    if (
      q.startsWith(
        "SELECT * FROM developer_claims WHERE claimant_id = ? ORDER BY created_at DESC"
      )
    ) {
      return [...this.tables.developer_claims.values()]
        .filter((r) => r.claimant_id === p[0])
        .sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at))
        );
    }

    if (
      q.startsWith(
        "SELECT c.*, d.name AS developer_name, d.type AS developer_type"
      )
    ) {
      return [...this.tables.developer_claims.values()]
        .filter((r) => r.status === "pending")
        .sort((a, b) =>
          String(a.created_at).localeCompare(String(b.created_at))
        )
        .map((r) => {
          const developer = this.tables.developers.get(String(r.developer_id));
          return {
            ...r,
            developer_name: developer?.name ?? "",
            developer_type: developer?.type ?? "user"
          };
        });
    }

    if (
      q.startsWith(
        "UPDATE developer_claims SET status = 'approved', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
      )
    ) {
      const [reviewer_id, id] = p;
      const row = this.tables.developer_claims.get(String(id));
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
        "UPDATE developers SET owner_user_id = ?, approved_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_user_id IS NULL"
      )
    ) {
      const [owner_user_id, id] = p;
      const row = this.tables.developers.get(String(id));
      if (row && row.owner_user_id === null) {
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
        "UPDATE developer_claims SET status = 'rejected', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = 'Another claim on this profile was approved' WHERE changes() = 1 AND developer_id = ?"
      )
    ) {
      const [reviewer_id, developer_id, excludeId] = p;
      const now = new Date().toISOString();
      for (const row of this.tables.developer_claims.values()) {
        if (
          row.developer_id === developer_id &&
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
        "UPDATE developer_claims SET status = 'pending', reviewer_id = NULL, reviewed_at = NULL WHERE id = ?"
      )
    ) {
      const [id] = p;
      const row = this.tables.developer_claims.get(String(id));
      if (row) {
        row.status = "pending";
        row.reviewer_id = null;
        row.reviewed_at = null;
      }
      return [];
    }

    if (
      q.startsWith(
        "UPDATE developer_claims SET status = 'rejected', reviewer_id = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
      )
    ) {
      const [reviewer_id, review_note, id] = p;
      const row = this.tables.developer_claims.get(String(id));
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
        "INSERT INTO extension_submissions (id, extension_id, developer_id, submitted_by, status, payload)"
      )
    ) {
      const [id, extension_id, developer_id, submitted_by, payload] = p;
      this.tables.extension_submissions.set(String(id), {
        id,
        extension_id,
        developer_id,
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
      q.startsWith(
        "INSERT INTO developers (id, type, name, url, owner_user_id)"
      )
    ) {
      const [id, type, name, url, owner_user_id] = p;
      const existing = this.tables.developers.get(String(id));
      this.tables.developers.set(String(id), {
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

    // These three mirror deleteOwn()'s guarded deletes: eligibility (still
    // owned by the given user, no extensions, no pending submission) is
    // re-checked per statement, same as the real correlated-subquery SQL,
    // so a stale/raced caller sees all three affect zero rows here too.
    if (
      q.startsWith("DELETE FROM developer_transfers WHERE developer_id = ?")
    ) {
      const [developer_id, owner_user_id] = p;
      let changes = 0;
      if (
        this.isEligibleForDeveloperDeletion(String(developer_id), owner_user_id)
      ) {
        for (const [key, row] of this.tables.developer_transfers) {
          if (row.developer_id === developer_id) {
            this.tables.developer_transfers.delete(key);
            changes++;
          }
        }
      }
      this.changes = changes;
      return [];
    }

    if (q.startsWith("DELETE FROM developer_claims WHERE developer_id = ?")) {
      const [developer_id, owner_user_id] = p;
      let changes = 0;
      if (
        this.isEligibleForDeveloperDeletion(String(developer_id), owner_user_id)
      ) {
        for (const [key, row] of this.tables.developer_claims) {
          if (row.developer_id === developer_id) {
            this.tables.developer_claims.delete(key);
            changes++;
          }
        }
      }
      this.changes = changes;
      return [];
    }

    if (q.startsWith("DELETE FROM developers WHERE id = ?")) {
      const [id, owner_user_id] = p;
      const eligible = this.isEligibleForDeveloperDeletion(
        String(id),
        owner_user_id
      );
      this.changes =
        eligible && this.tables.developers.delete(String(id)) ? 1 : 0;
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
