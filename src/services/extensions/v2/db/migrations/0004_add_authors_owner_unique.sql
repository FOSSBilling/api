-- v2: enforce one profile per owner at the database level. Without this,
-- two concurrent first-time PUT /authors/me requests with different ids
-- (same caller) could both pass the app-level "do I already have a
-- profile?" check and both insert, leaving the caller with two profiles.
-- NULL owner_user_id (pre-v2 rows) is exempt: SQLite never treats NULLs as
-- equal in a unique index, so legacy unowned authors can coexist freely.
--
-- The race this closes predates this migration, so a database may already
-- have duplicate owner_user_id rows — CREATE UNIQUE INDEX would fail on
-- those and block every migration after it. Detach ownership (not delete)
-- from all but the most recently created row per owner first, so the
-- constraint can always be created; any detached profile becomes unowned,
-- same as a legacy pre-v2 row, and needs manual reconciliation.
UPDATE authors
SET owner_user_id = NULL
WHERE owner_user_id IS NOT NULL
  AND rowid NOT IN (
    SELECT MAX(rowid) FROM authors
    WHERE owner_user_id IS NOT NULL
    GROUP BY owner_user_id
  );

DROP INDEX IF EXISTS idx_authors_owner;
CREATE UNIQUE INDEX IF NOT EXISTS idx_authors_owner_unique ON authors(owner_user_id);
