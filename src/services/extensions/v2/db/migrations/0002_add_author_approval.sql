-- v2: direct (unmoderated) developer-profile writes, with a moderator-set
-- "approved" trust flag. Adds to the v1-owned `authors` table.
--
-- SQLite's ALTER TABLE ADD COLUMN rejects non-constant defaults (including
-- CURRENT_TIMESTAMP), so created_at/updated_at are added with a placeholder
-- default and backfilled immediately after. New rows always set these
-- explicitly (see authors-database.ts), so the placeholder is never seen
-- outside of this migration.

ALTER TABLE authors ADD COLUMN approved_at TEXT;
ALTER TABLE authors ADD COLUMN created_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE authors ADD COLUMN updated_at  TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

UPDATE authors SET created_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_authors_approved ON authors(approved_at);
