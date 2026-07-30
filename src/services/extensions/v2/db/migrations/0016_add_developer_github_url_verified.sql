ALTER TABLE developers ADD COLUMN github_url_verified INTEGER CHECK (github_url_verified IN (0, 1));
