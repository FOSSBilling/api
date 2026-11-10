-- v2: DELETE /developers/me needs to hard-delete a developers row while
-- deliberately keeping its developer_history rows (the audit trail must
-- survive profile deletion). developer_history.developer_id currently has a
-- hard FK to developers(id) with no ON DELETE action, so as soon as D1
-- enforces foreign keys (it does, by default) that delete fails outright —
-- confirmed empirically against local D1 before writing this migration.
--
-- SQLite can't ALTER a FK constraint away, so the table is rebuilt without
-- it. developer_id keeps its NOT NULL and its historical value once a
-- developer is deleted; it's just no longer a live, enforced reference.
-- Everything else (columns, the append-only triggers, the index) is
-- unchanged. Existing rows are preserved, re-inserted in original rowid
-- order so the "ORDER BY changed_at DESC, rowid DESC" tie-break in
-- listHistory keeps meaning what it always meant.

CREATE TABLE developer_history_new (
  id           TEXT PRIMARY KEY NOT NULL,
  developer_id TEXT NOT NULL,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  url          TEXT,
  changed_by   TEXT NOT NULL REFERENCES users(id),
  changed_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO developer_history_new (id, developer_id, type, name, url, changed_by, changed_at)
SELECT id, developer_id, type, name, url, changed_by, changed_at
FROM developer_history
ORDER BY rowid;

DROP TABLE developer_history;
ALTER TABLE developer_history_new RENAME TO developer_history;

CREATE INDEX IF NOT EXISTS idx_developer_history_developer_changed_at
  ON developer_history(developer_id, changed_at);

CREATE TRIGGER IF NOT EXISTS trg_developer_history_no_update
BEFORE UPDATE ON developer_history
BEGIN
  SELECT RAISE(ABORT, 'developer_history is append-only: rows cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_developer_history_no_delete
BEFORE DELETE ON developer_history
BEGIN
  SELECT RAISE(ABORT, 'developer_history is append-only: rows cannot be deleted');
END;
