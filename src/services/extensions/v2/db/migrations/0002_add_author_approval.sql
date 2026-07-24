-- v2: direct (unmoderated) developer-profile writes, with a moderator-set
-- "approved" trust flag. Adds to the v1-owned `authors` table.

ALTER TABLE authors ADD COLUMN approved_at TEXT;
ALTER TABLE authors ADD COLUMN created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE authors ADD COLUMN updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_authors_approved ON authors(approved_at);
