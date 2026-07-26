-- v2: claim requests for unowned ("legacy") developer profiles. A claim
-- doesn't change ownership by itself — only approve() does that.

CREATE TABLE IF NOT EXISTS author_claims (
  id          TEXT PRIMARY KEY NOT NULL,
  author_id   TEXT NOT NULL REFERENCES authors(id),
  claimant_id TEXT NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  note        TEXT,
  review_note TEXT,
  reviewer_id TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_author_claims_author ON author_claims(author_id);
CREATE INDEX IF NOT EXISTS idx_author_claims_claimant ON author_claims(claimant_id);

-- One pending claim per (author, claimant) at a time — re-claiming while
-- already pending is a no-op, not a new row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_author_claims_pending_unique
  ON author_claims(author_id, claimant_id)
  WHERE status = 'pending';
