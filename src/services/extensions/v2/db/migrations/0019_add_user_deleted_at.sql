-- Keep the stable auth subject as a tombstone when an account is deleted so
-- existing foreign keys and audit history remain valid. A later identity
-- sync reactivates the same row and clears this value.
ALTER TABLE users ADD COLUMN deleted_at TEXT;
