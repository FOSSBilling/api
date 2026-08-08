import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../src/services/extensions/v2/db/migrations"
);

const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .sort();

function migration(name: string): string {
  return readFileSync(join(migrationsDirectory, name), "utf8");
}

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

// This is the users table created by the former Extensions site migration.
// The API's 0000 bootstrap must be able to run after this table already exists
// without replacing its rows or narrowing its identity projection.
const historicalUsersSchema = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT,
    email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    picture TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_moderator INTEGER NOT NULL DEFAULT 0,
    display_name TEXT,
    github_login TEXT,
    github_orgs TEXT,
    github_orgs_expires_at TEXT
  );
`;

// A published extension owned by an active submitter, the starting point for
// the legacy-submission cases below.
function seedSubmissionFixture(db: DatabaseSync): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO users (id, created_at, updated_at) VALUES (?,?,?)"
  ).run("submitter", now, now);
  db.prepare(
    "INSERT INTO developers (id, type, name, owner_user_id) VALUES (?,?,?,?)"
  ).run("acme", "organization", "Acme", "submitter");
  db.prepare(
    `INSERT INTO extensions (
      id, type, author_id, name, description, releases, website, license,
      icon_url, readme, source, version, download_url
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "live-ext",
    "mod",
    "acme",
    "Live",
    "description",
    "[]",
    "https://example.com",
    '{"name":"MIT"}',
    null,
    "# Live",
    '{"type":"github","repo":"example/live"}',
    "1.0.0",
    "https://example.com/live.zip"
  );
}

describe("Extensions D1 migrations", () => {
  it("upgrades the split-owned schema without losing users or domain references", () => {
    const db = new DatabaseSync(":memory:");

    try {
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(historicalUsersSchema);
      db.prepare(
        `INSERT INTO users (
          id, name, email, email_verified, picture, created_at, updated_at,
          is_moderator, display_name, github_login, github_orgs,
          github_orgs_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "legacy-user",
        "Legacy User",
        "legacy@example.com",
        1,
        "https://example.com/avatar.png",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        0,
        "Legacy",
        "legacy-github",
        '["legacy-org"]',
        "2030-01-01T00:00:00.000Z"
      );

      // Apply the complete API chain, including the idempotent bootstrap, to
      // the already-populated users table. 0019 is kept separate so the
      // assertions prove that the adoption migration is the only schema
      // change needed for the old split-owned database. 0021 is held back
      // with it so this test can seed pre-0021 rows and then watch them
      // migrate; the assertions after it cover the restructure.
      const heldBack = new Set([
        "0019_add_user_deleted_at.sql",
        "0021_restructure_extensions_revisions.sql"
      ]);
      for (const name of migrationNames.filter(
        (candidate) => !heldBack.has(candidate)
      )) {
        db.exec(migration(name));
      }

      expect(columnNames(db, "users")).not.toContain("deleted_at");

      db.prepare(
        `INSERT INTO developers (id, type, name, url, owner_user_id)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        "legacy-developer",
        "user",
        "Legacy Developer",
        null,
        "legacy-user"
      );
      db.prepare(
        `INSERT INTO extensions (
          id, type, author_id, name, description, releases, website, license,
          icon_url, readme, source, version, download_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "legacy-extension",
        "mod",
        "legacy-developer",
        "Legacy Extension",
        "description",
        "[]",
        "https://example.com",
        '{"name":"MIT"}',
        null,
        "# Legacy",
        '{"type":"github","repo":"example/legacy"}',
        "1.0.0",
        "https://example.com/legacy.zip"
      );
      db.prepare(
        `INSERT INTO extension_submissions (
          id, extension_id, developer_id, submitted_by, status, payload,
          target_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "legacy-submission",
        "legacy-extension",
        "legacy-developer",
        "legacy-user",
        "pending",
        '{"developer":{"id":"legacy-developer"},"extension":{"id":"legacy-extension"}}',
        "legacy-extension"
      );
      db.prepare(
        `INSERT INTO developer_history (
          id, developer_id, type, name, url, changed_by
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        "legacy-history",
        "legacy-developer",
        "user",
        "Legacy Developer",
        null,
        "legacy-user"
      );

      db.exec(migration("0019_add_user_deleted_at.sql"));
      db.exec(migration("0021_restructure_extensions_revisions.sql"));

      expect(columnNames(db, "users")).toEqual([
        "id",
        "name",
        "email",
        "email_verified",
        "picture",
        "created_at",
        "updated_at",
        "is_moderator",
        "display_name",
        "github_login",
        "github_orgs",
        "github_orgs_expires_at",
        "deleted_at"
      ]);
      expect(
        db
          .prepare(
            "SELECT id, name, email, github_login, deleted_at FROM users WHERE id = ?"
          )
          .get("legacy-user")
      ).toEqual({
        id: "legacy-user",
        name: "Legacy User",
        email: "legacy@example.com",
        github_login: "legacy-github",
        deleted_at: null
      });
      expect(
        db
          .prepare("SELECT owner_user_id FROM developers WHERE id = ?")
          .get("legacy-developer")
      ).toEqual({ owner_user_id: "legacy-user" });
      expect(
        db
          .prepare("SELECT submitted_by FROM extension_revisions WHERE id = ?")
          .get("legacy-submission")
      ).toEqual({ submitted_by: "legacy-user" });
      expect(
        db
          .prepare("SELECT changed_by FROM developer_history WHERE id = ?")
          .get("legacy-history")
      ).toEqual({ changed_by: "legacy-user" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      // 0021 rebuilds developers only to replace the placeholder 1970 default
      // migration 0002 was forced to use. Rows keep whatever they had - a
      // wrong-but-real timestamp beats one invented here - while a new insert
      // that omits the column now gets the value every writer already uses.
      expect(
        db
          .prepare("SELECT created_at FROM developers WHERE id = ?")
          .get("legacy-developer")
      ).toEqual({ created_at: "1970-01-01T00:00:00.000Z" });

      db.prepare(
        "INSERT INTO developers (id, type, name, owner_user_id) VALUES (?,?,?,?)"
      ).run("post-migration", "user", "After", null);
      const fresh = db
        .prepare("SELECT created_at, updated_at FROM developers WHERE id = ?")
        .get("post-migration") as { created_at: string; updated_at: string };
      expect(fresh.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(fresh.updated_at).toBe(fresh.created_at);
    } finally {
      db.close();
    }
  });

  // idx_extensions_id_nocase cannot be created over a catalogue that already
  // holds a case-colliding pair. Without a check first, the failure lands
  // mid-rebuild as a bare UNIQUE constraint error naming no rows.
  it("0021 refuses to run against ids that differ only in case", () => {
    const db = new DatabaseSync(":memory:");

    try {
      for (const name of migrationNames.filter(
        (candidate) => !candidate.startsWith("0021")
      )) {
        db.exec(migration(name));
      }
      seedSubmissionFixture(db);
      db.prepare(
        `INSERT INTO extensions (
          id, type, author_id, name, description, releases, website, license,
          icon_url, readme, source, version, download_url
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        "LIVE-EXT",
        "mod",
        "acme",
        "Colliding",
        "description",
        "[]",
        "https://example.com",
        '{"name":"MIT"}',
        null,
        "# Colliding",
        '{"type":"github","repo":"example/colliding"}',
        "1.0.0",
        "https://example.com/colliding.zip"
      );

      expect(() =>
        db.exec(migration("0021_restructure_extensions_revisions.sql"))
      ).toThrow(
        /CHECK constraint failed: extension_ids_must_not_differ_only_by_case/
      );

      // Failed before touching anything, not halfway through the rebuild.
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM extension_submissions").get()
      ).toEqual({ n: 0 });
      expect(columnNames(db, "extensions")).toContain("author_id");
    } finally {
      db.close();
    }
  });

  // The pre-0021 flow could leave a submission naming a developer that does
  // not exist. Such a row is already unapprovable - the old approve() only
  // ever UPDATEd a developer - but it must not vanish without saying so.
  it("0021 refuses to drop a submission whose developer does not exist", () => {
    const db = new DatabaseSync(":memory:");

    try {
      for (const name of migrationNames.filter(
        (candidate) => !candidate.startsWith("0021")
      )) {
        db.exec(migration(name));
      }
      seedSubmissionFixture(db);
      db.prepare(
        `INSERT INTO extension_submissions
           (id, extension_id, developer_id, submitted_by, status, payload, target_key)
         VALUES (?,?,?,?,?,?,?)`
      ).run(
        "introduces-a-developer",
        null,
        "not-yet-created",
        "submitter",
        "pending",
        '{"developer":{"id":"not-yet-created"},"extension":{"id":"brand-new"}}',
        "brand-new"
      );

      expect(() =>
        db.exec(migration("0021_restructure_extensions_revisions.sql"))
      ).toThrow(
        /CHECK constraint failed: submissions_must_name_an_existing_developer/
      );
    } finally {
      db.close();
    }
  });

  // The same row targeting an extension that already exists is fine: it
  // becomes a revision, and the ownership pass rejects it rather than leaving
  // it pending forever.
  it("0021 keeps a submission whose developer is missing but whose extension exists", () => {
    const db = new DatabaseSync(":memory:");

    try {
      for (const name of migrationNames.filter(
        (candidate) => !candidate.startsWith("0021")
      )) {
        db.exec(migration(name));
      }
      seedSubmissionFixture(db);
      db.prepare(
        `INSERT INTO extension_submissions
           (id, extension_id, developer_id, submitted_by, status, payload, target_key)
         VALUES (?,?,?,?,?,?,?)`
      ).run(
        "ghost-developer",
        "live-ext",
        "vanished",
        "submitter",
        "pending",
        '{"developer":{"id":"vanished"},"extension":{"id":"live-ext"}}',
        "live-ext"
      );

      db.exec(migration("0021_restructure_extensions_revisions.sql"));

      expect(
        db
          .prepare(
            "SELECT status, review_note FROM extension_revisions WHERE id = ?"
          )
          .get("ghost-developer")
      ).toEqual({
        status: "rejected",
        review_note: "Ownership changed before review"
      });
    } finally {
      db.close();
    }
  });

  // Approval no longer looks at the proposed id - there is nothing to look at,
  // since the id lives on the extension row. So the reserved-id check that
  // used to run at the approval boundary has to run here instead, before a
  // submission can materialise an extension the public route cannot serve.
  it("0021 refuses to materialise a submission targeting a reserved id", () => {
    const db = new DatabaseSync(":memory:");

    try {
      for (const name of migrationNames.filter(
        (candidate) => !candidate.startsWith("0021")
      )) {
        db.exec(migration(name));
      }
      seedSubmissionFixture(db);
      db.prepare(
        `INSERT INTO extension_submissions
           (id, extension_id, developer_id, submitted_by, status, payload, target_key)
         VALUES (?,?,?,?,?,?,?)`
      ).run(
        "reserved",
        null,
        "acme",
        "submitter",
        "pending",
        '{"developer":{"id":"acme"},"extension":{"id":"Mine"}}',
        "mine"
      );

      expect(() =>
        db.exec(migration("0021_restructure_extensions_revisions.sql"))
      ).toThrow(
        /CHECK constraint failed: submission_target_ids_must_not_be_reserved/
      );
    } finally {
      db.close();
    }
  });

  // At most one revision per extension may be pending, so a legacy row that
  // can never satisfy approve()'s ownership predicate would sit there forever
  // and block the owner from ever submitting another edit.
  it("0021 rejects pending submissions that could never be approved", () => {
    const db = new DatabaseSync(":memory:");

    try {
      for (const name of migrationNames.filter(
        (candidate) => !candidate.startsWith("0021")
      )) {
        db.exec(migration(name));
      }
      seedSubmissionFixture(db);
      db.prepare(
        "INSERT INTO developers (id, type, name, owner_user_id) VALUES (?,?,?,?)"
      ).run("other", "user", "Other", null);

      const insert = db.prepare(
        `INSERT INTO extension_submissions
           (id, extension_id, developer_id, submitted_by, status, payload, ownership_epoch, target_key)
         VALUES (?,?,?,?,?,?,?,?)`
      );
      // Approvable: developer exists, owned by the submitter, epoch matches,
      // and is the extension's own developer.
      insert.run(
        "ok",
        "live-ext",
        "acme",
        "submitter",
        "pending",
        '{"developer":{"id":"acme"},"extension":{"id":"live-ext","name":"A"}}',
        1,
        "live-ext"
      );
      // Names a developer that is not the extension's.
      insert.run(
        "wrong-developer",
        "live-ext",
        "other",
        "submitter",
        "pending",
        '{"developer":{"id":"other"},"extension":{"id":"live-ext","name":"B"}}',
        1,
        "live-ext-2"
      );
      // Filed under an ownership epoch that has since moved on.
      insert.run(
        "stale-epoch",
        "live-ext",
        "acme",
        "submitter",
        "pending",
        '{"developer":{"id":"acme"},"extension":{"id":"live-ext","name":"C"}}',
        7,
        "live-ext-3"
      );

      db.exec(migration("0021_restructure_extensions_revisions.sql"));

      expect(
        db
          .prepare(
            "SELECT id, status, review_note FROM extension_revisions ORDER BY id"
          )
          .all()
      ).toEqual([
        { id: "ok", status: "pending", review_note: null },
        {
          id: "stale-epoch",
          status: "rejected",
          review_note: "Ownership changed before review"
        },
        {
          id: "wrong-developer",
          status: "rejected",
          review_note: "Ownership changed before review"
        }
      ]);
    } finally {
      db.close();
    }
  });

  // The reads in db/extensions.ts and v1/database.ts inner-join developers and
  // treat the result as always present. That is only sound because 0021
  // refuses to carry a dangling reference through its foreign_keys=OFF
  // rebuild, so the refusal is worth pinning.
  it("0021 refuses to migrate an extension whose developer is missing", () => {
    const db = new DatabaseSync(":memory:");

    try {
      for (const name of migrationNames.filter(
        (candidate) => !candidate.startsWith("0021")
      )) {
        db.exec(migration(name));
      }

      // Enforcement off, which is exactly how such a row could have come to
      // exist before the constraint was there to stop it.
      db.exec("PRAGMA foreign_keys = OFF;");
      db.prepare(
        `INSERT INTO extensions (
          id, type, author_id, name, description, releases, website, license,
          icon_url, readme, source, version, download_url
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        "dangling",
        "mod",
        "developer-that-never-existed",
        "Dangling",
        "d",
        "[]",
        "https://example.com",
        '{"name":"MIT"}',
        null,
        "# d",
        '{"type":"github","repo":"example/d"}',
        "1.0.0",
        "https://example.com/d.zip"
      );

      expect(() =>
        db.exec(migration("0021_restructure_extensions_revisions.sql"))
      ).toThrow(/CHECK constraint failed: extension_references_must_resolve/);
    } finally {
      db.close();
    }
  });

  it("0021 gives every submission a real extension row to hang off", () => {
    const db = new DatabaseSync(":memory:");

    try {
      db.exec("PRAGMA foreign_keys = ON;");
      for (const name of migrationNames.filter(
        (candidate) => !candidate.startsWith("0021")
      )) {
        db.exec(migration(name));
      }

      const now = "2026-01-01T00:00:00.000Z";
      db.prepare(
        "INSERT INTO users (id, created_at, updated_at) VALUES (?,?,?)"
      ).run("submitter", now, now);
      db.prepare(
        "INSERT INTO developers (id, type, name, owner_user_id) VALUES (?,?,?,?)"
      ).run("acme", "organization", "Acme", "submitter");
      db.prepare(
        `INSERT INTO extensions (
          id, type, author_id, name, description, releases, website, license,
          icon_url, readme, source, version, download_url
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        "live-ext",
        "mod",
        "acme",
        "Live",
        "description",
        "[]",
        "https://example.com",
        '{"name":"MIT"}',
        null,
        "# Live",
        '{"type":"github","repo":"example/live"}',
        "1.0.0",
        "https://example.com/live.zip"
      );

      const payload = (extensionId: string) =>
        JSON.stringify({
          developer: { id: "acme", type: "organization", name: "Acme" },
          extension: { id: extensionId, name: "Proposed", type: "mod" }
        });
      const insertSubmission = db.prepare(
        `INSERT INTO extension_submissions
           (id, extension_id, developer_id, submitted_by, status, payload, created_at, target_key)
         VALUES (?,?,?,?,?,?,?,?)`
      );
      insertSubmission.run(
        "edit-of-live",
        "live-ext",
        "acme",
        "submitter",
        "pending",
        payload("live-ext"),
        "2026-01-02",
        "live-ext"
      );
      insertSubmission.run(
        "brand-new",
        null,
        "acme",
        "submitter",
        "pending",
        payload("not-yet-approved"),
        "2026-01-03",
        "not-yet-approved"
      );

      db.exec(migration("0021_restructure_extensions_revisions.sql"));

      // Rows that were already in the catalogue are published; a submission
      // that only ever proposed an id becomes an unpublished extension.
      expect(
        db
          .prepare(
            "SELECT id, developer_id, published_at IS NOT NULL AS published FROM extensions ORDER BY id"
          )
          .all()
      ).toEqual([
        { id: "live-ext", developer_id: "acme", published: 1 },
        { id: "not-yet-approved", developer_id: "acme", published: 0 }
      ]);

      expect(
        db
          .prepare(
            "SELECT id, extension_id, status FROM extension_revisions ORDER BY id"
          )
          .all()
      ).toEqual([
        {
          id: "brand-new",
          extension_id: "not-yet-approved",
          status: "pending"
        },
        { id: "edit-of-live", extension_id: "live-ext", status: "pending" }
      ]);

      // The payload's developer half and the extension id are both gone: a
      // revision proposes content, and nothing else.
      expect(
        db
          .prepare("SELECT content FROM extension_revisions WHERE id = ?")
          .get("edit-of-live")
      ).toEqual({ content: '{"name":"Proposed","type":"mod"}' });

      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      // published_at cannot be set on a row with no content.
      expect(() =>
        db
          .prepare("UPDATE extensions SET published_at = ? WHERE id = ?")
          .run(now, "not-yet-approved")
      ).toThrow(/extensions_published_content_check/);
    } finally {
      db.close();
    }
  });
});
