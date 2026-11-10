-- v2: rename "authors" to "developers" everywhere v2 owns the name. "Author"
-- implied solo/literary authorship, which never fit an entity that can be an
-- organization, gets moderated/approved, and can be transferred or claimed
-- like any other account. Now, while v2 is still internal-only, is the
-- cheapest this ever gets to fix.
--
-- v1's read-only extension-listing API (src/services/extensions/v1) is
-- unaffected: its JSON response still calls this field "author"
-- (v1/interfaces.ts), and extensions.author_id (v1's own column) is left
-- as-is. Only the query in v1/database.ts that joins this table follows the
-- rename.

ALTER TABLE authors RENAME TO developers;

DROP INDEX IF EXISTS idx_authors_owner_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_developers_owner_unique ON developers(owner_user_id);

DROP INDEX IF EXISTS idx_authors_approved;
CREATE INDEX IF NOT EXISTS idx_developers_approved ON developers(approved_at);

-- Not a hard FK (see 0001_add_v2_tables.sql), but renamed to match anyway.
ALTER TABLE extension_submissions RENAME COLUMN author_id TO developer_id;
DROP INDEX IF EXISTS idx_submissions_author;
CREATE INDEX IF NOT EXISTS idx_submissions_developer ON extension_submissions(developer_id);

-- extension_submissions.payload is a JSON blob (SubmissionPayload), not a
-- SQL column, so the ALTER above doesn't touch it — every already-persisted
-- row (any status) still has the old `{"author": {...}, "extension": {...}}`
-- shape. Translate it in place so it matches the renamed
-- SubmissionPayloadSchema everywhere, not just for submissions created after
-- this migration. Without this, approve() on a pre-existing pending
-- submission dereferences payload.developer on an object that only has
-- .author, throwing and surfacing as a generic database error forever; list
-- responses would also keep serving the old shape for old rows.
UPDATE extension_submissions
SET payload = json_set(
  json_remove(payload, '$.author'),
  '$.developer',
  json_extract(payload, '$.author')
)
WHERE json_extract(payload, '$.author') IS NOT NULL
  AND json_extract(payload, '$.developer') IS NULL;

ALTER TABLE author_history RENAME TO developer_history;
ALTER TABLE developer_history RENAME COLUMN author_id TO developer_id;

DROP INDEX IF EXISTS idx_author_history_author_changed_at;
CREATE INDEX IF NOT EXISTS idx_developer_history_developer_changed_at
  ON developer_history(developer_id, changed_at);

DROP TRIGGER IF EXISTS trg_author_history_no_update;
CREATE TRIGGER IF NOT EXISTS trg_developer_history_no_update
BEFORE UPDATE ON developer_history
BEGIN
  SELECT RAISE(ABORT, 'developer_history is append-only: rows cannot be updated');
END;

DROP TRIGGER IF EXISTS trg_author_history_no_delete;
CREATE TRIGGER IF NOT EXISTS trg_developer_history_no_delete
BEFORE DELETE ON developer_history
BEGIN
  SELECT RAISE(ABORT, 'developer_history is append-only: rows cannot be deleted');
END;

ALTER TABLE author_transfers RENAME TO developer_transfers;
ALTER TABLE developer_transfers RENAME COLUMN author_id TO developer_id;

DROP INDEX IF EXISTS idx_author_transfers_token;
CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_transfers_token ON developer_transfers(token_hash);

DROP INDEX IF EXISTS idx_author_transfers_pending;
CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_transfers_pending
  ON developer_transfers(developer_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE author_claims RENAME TO developer_claims;
ALTER TABLE developer_claims RENAME COLUMN author_id TO developer_id;

DROP INDEX IF EXISTS idx_author_claims_author;
CREATE INDEX IF NOT EXISTS idx_developer_claims_developer ON developer_claims(developer_id);

DROP INDEX IF EXISTS idx_author_claims_claimant;
CREATE INDEX IF NOT EXISTS idx_developer_claims_claimant ON developer_claims(claimant_id);

DROP INDEX IF EXISTS idx_author_claims_pending_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_claims_pending_unique
  ON developer_claims(developer_id, claimant_id)
  WHERE status = 'pending';

DROP INDEX IF EXISTS idx_author_claims_pending_queue;
CREATE INDEX IF NOT EXISTS idx_developer_claims_pending_queue
  ON developer_claims(created_at)
  WHERE status = 'pending';
