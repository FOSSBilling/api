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
      // change needed for the old split-owned database.
      for (const name of migrationNames.filter(
        (candidate) => candidate !== "0019_add_user_deleted_at.sql"
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
          .prepare(
            "SELECT submitted_by FROM extension_submissions WHERE id = ?"
          )
          .get("legacy-submission")
      ).toEqual({ submitted_by: "legacy-user" });
      expect(
        db
          .prepare("SELECT changed_by FROM developer_history WHERE id = ?")
          .get("legacy-history")
      ).toEqual({ changed_by: "legacy-user" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
