CREATE TABLE IF NOT EXISTS extensions (
  id           TEXT PRIMARY KEY NOT NULL,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  author       TEXT NOT NULL,
  releases     TEXT NOT NULL,
  website      TEXT NOT NULL,
  license      TEXT NOT NULL,
  icon_url     TEXT,
  readme       TEXT NOT NULL,
  source       TEXT NOT NULL,
  version      TEXT NOT NULL,
  download_url TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extensions_type ON extensions(type);
