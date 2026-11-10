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

-- Covers listHistory's `WHERE author_id = ? ORDER BY changed_at DESC` —
-- without changed_at in the index, SQLite finds the matching rows fine but
-- then needs a temp b-tree to sort them. With it, a reverse index scan
-- (implicitly tie-broken by rowid, ascending within each changed_at) walks
-- the rows in the exact order the query wants, so no sort step is needed.
CREATE INDEX IF NOT EXISTS idx_author_history_author_changed_at
  ON author_history(author_id, changed_at);

-- Enforces the append-only guarantee this table exists for: nothing in this
-- codebase ever updates or deletes a history row, but without a trigger
-- that's a convention, not a fact — a future bug (or an ad-hoc admin query)
-- could silently rewrite audit history. These make that a hard failure.
CREATE TRIGGER IF NOT EXISTS trg_author_history_no_update
BEFORE UPDATE ON author_history
BEGIN
  SELECT RAISE(ABORT, 'author_history is append-only: rows cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_author_history_no_delete
BEFORE DELETE ON author_history
BEGIN
  SELECT RAISE(ABORT, 'author_history is append-only: rows cannot be deleted');
END;
