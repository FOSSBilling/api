-- v2: one-time links for handing a developer profile to a different account.
-- Only the token's SHA-256 hash is stored, never the plaintext — same reason
-- passwords are hashed, since anyone who reads this table shouldn't be able
-- to use it to accept a transfer themselves.

CREATE TABLE IF NOT EXISTS author_transfers (
  id          TEXT PRIMARY KEY NOT NULL,
  author_id   TEXT NOT NULL REFERENCES authors(id),
  token_hash  TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  TEXT NOT NULL,
  accepted_by TEXT REFERENCES users(id),
  accepted_at TEXT,
  revoked_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_author_transfers_token ON author_transfers(token_hash);

-- At most one active (not yet accepted, not revoked) transfer per author —
-- requesting a new one supersedes any old one rather than stacking up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_author_transfers_pending
  ON author_transfers(author_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
