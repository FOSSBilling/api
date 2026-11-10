CREATE TABLE claim_verification_budgets (
  key TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_claim_verification_budgets_expiry ON claim_verification_budgets (expires_at);
