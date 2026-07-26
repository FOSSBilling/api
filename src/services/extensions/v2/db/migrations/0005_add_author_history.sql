-- v2: append-only audit log for authors writes via PUT /authors/me. One row
-- per write (including the initial create), oldest state is never mutated or
-- deleted — this is purely additive.

CREATE TABLE IF NOT EXISTS author_history (
  id         TEXT PRIMARY KEY NOT NULL,
  author_id  TEXT NOT NULL REFERENCES authors(id),
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  url        TEXT,
  changed_by TEXT NOT NULL REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_author_history_author ON author_history(author_id);
