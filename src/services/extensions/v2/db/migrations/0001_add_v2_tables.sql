-- Migration number: 0001 	 2026-07-24T06:49:28.535Z
--
-- v2: self-service submissions, ownership, moderation.
-- Adds to the v1-owned `authors` table (../../v1/db/schema.sql) and creates a new
-- v2-owned table.
--
-- NOTE: `users` referenced below is owned by the FOSSBilling/extensions repo
-- (src/lib/db/users.sql there), NOT this repo, but lives in the same DB_EXTENSIONS
-- database. If that schema changes, update fossbilling/api AND that file. Assumed
-- columns used here: users.id (TEXT, = auth `sub` claim), users.is_moderator
-- (INTEGER 0/1).
--
-- Bootstrap order for a fresh database: v1's schema.sql (../../v1/db/schema.sql,
-- creates `authors`/`extensions`) and the extensions repo's `users` table must
-- both exist before this migration runs, since it ALTERs/references them.

ALTER TABLE authors ADD COLUMN owner_user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_authors_owner ON authors(owner_user_id);

CREATE TABLE IF NOT EXISTS extension_submissions (
  id           TEXT PRIMARY KEY NOT NULL,
  extension_id TEXT REFERENCES extensions(id), -- NULL = new extension, set = edit
  author_id    TEXT NOT NULL,                  -- not a hard FK: may name an author
                                                 -- that doesn't exist yet (created on approval)
  submitted_by TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  payload      TEXT NOT NULL, -- JSON: { author: {...}, extension: {...} }
  reviewer_id  TEXT REFERENCES users(id),
  review_note  TEXT,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at  DATETIME
);

CREATE INDEX IF NOT EXISTS idx_submissions_status       ON extension_submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_submitted_by ON extension_submissions(submitted_by);
CREATE INDEX IF NOT EXISTS idx_submissions_author       ON extension_submissions(author_id);
CREATE INDEX IF NOT EXISTS idx_submissions_extension    ON extension_submissions(extension_id);
