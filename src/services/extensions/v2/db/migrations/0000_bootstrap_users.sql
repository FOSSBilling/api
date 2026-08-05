-- Bootstrap the complete pre-adoption Extensions schema before the v2
-- migrations add ownership, moderation, and workflow state. The CREATEs are
-- intentionally idempotent: production databases already contain these
-- tables from the former split migration chains, while a fresh API-owned
-- database does not. Keeping the legacy catalogue tables in this baseline
-- means the API migration directory can be applied to an empty database.
CREATE TABLE IF NOT EXISTS authors (
  id   TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  url  TEXT
);

CREATE TABLE IF NOT EXISTS extensions (
  id           TEXT PRIMARY KEY NOT NULL,
  type         TEXT NOT NULL,
  author_id    TEXT NOT NULL REFERENCES authors(id),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  releases     TEXT NOT NULL,
  website      TEXT NOT NULL,
  license      TEXT NOT NULL,
  icon_url     TEXT,
  readme       TEXT NOT NULL,
  source       TEXT NOT NULL,
  version      TEXT NOT NULL,
  download_url TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extensions_type ON extensions(type);
CREATE INDEX IF NOT EXISTS idx_extensions_author ON extensions(author_id);

-- The former Extensions site migration already created this complete
-- projection (it was never a one-column placeholder). Keeping IF NOT EXISTS
-- here is what makes adoption data-preserving: the API chain reuses that
-- table and 0019 adds only the new tombstone column. Deployments should
-- inspect PRAGMA table_info(users) during the rollout backup; a database that
-- does not match this historical contract is not an Extensions production
-- database that this additive chain can safely infer or rebuild in SQL.
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY NOT NULL,
  name           TEXT,
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  picture        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  is_moderator   INTEGER NOT NULL DEFAULT 0,
  display_name   TEXT,
  github_login   TEXT,
  github_orgs   TEXT,
  github_orgs_expires_at TEXT
);
