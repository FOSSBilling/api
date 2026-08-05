-- Migration number: 0001 	 2026-07-24T06:49:28.535Z
--
-- v2: self-service submissions, ownership, moderation.
-- Extends the legacy catalogue tables bootstrapped by migration 0000 and
-- creates the submission workflow table.
--
-- NOTE: `users` is part of this API-owned Extensions domain. Migration 0000
-- bootstraps it before this migration adds foreign keys to users(id).
--
ALTER TABLE authors ADD COLUMN owner_user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_authors_owner ON authors(owner_user_id);

CREATE TABLE IF NOT EXISTS extension_submissions (
  id           TEXT PRIMARY KEY NOT NULL,
  extension_id TEXT REFERENCES extensions(id), -- NULL = new extension, set = edit
  author_id    TEXT NOT NULL,                  -- submissions may name a developer
                                               -- that does not exist yet (created on approval)
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
