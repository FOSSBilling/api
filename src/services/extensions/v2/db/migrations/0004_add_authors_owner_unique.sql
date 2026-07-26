-- v2: enforce one profile per owner at the database level. Without this,
-- two concurrent first-time PUT /authors/me requests with different ids
-- (same caller) could both pass the app-level "do I already have a
-- profile?" check and both insert, leaving the caller with two profiles.
-- NULL owner_user_id (pre-v2 rows) is exempt: SQLite never treats NULLs as
-- equal in a unique index, so legacy unowned authors can coexist freely.

DROP INDEX IF EXISTS idx_authors_owner;
CREATE UNIQUE INDEX IF NOT EXISTS idx_authors_owner_unique ON authors(owner_user_id);
