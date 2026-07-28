-- Surfaces a GitHub org/user-membership signal on developer_claims for
-- moderator review. Populated by DevelopersDatabase.claim() — see that
-- method and github-verification.ts. Purely informational: never gates
-- approveClaim()/rejectClaim(), which remain a pure human decision. Only
-- ever written as 1 (verified match) or left NULL (no verifiable GitHub
-- entity for this id, or the claimant has no linked GitHub identity yet) —
-- a positive mismatch is rejected before a claim row is ever created, so 0
-- is never written today, but the CHECK stays permissive for future use.
ALTER TABLE developer_claims
  ADD COLUMN github_org_verified INTEGER CHECK (github_org_verified IN (0, 1));
ALTER TABLE developer_claims ADD COLUMN github_verification_note TEXT;
