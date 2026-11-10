ALTER TABLE developers ADD COLUMN github_org_verified INTEGER CHECK (github_org_verified IN (0, 1));
ALTER TABLE developers ADD COLUMN github_verification_note TEXT;
