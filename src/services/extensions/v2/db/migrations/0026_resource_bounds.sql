-- Admission and accounting share the content-write transaction. Backfill
-- preserves legacy content; existing over-quota collections cannot grow.
ALTER TABLE extensions ADD COLUMN created_by TEXT;
ALTER TABLE extensions ADD COLUMN published_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE extensions SET published_bytes = COALESCE(length(CAST(extensions.type AS BLOB)),0)
    + COALESCE(length(CAST(extensions.name AS BLOB)),0)
    + COALESCE(length(CAST(extensions.description AS BLOB)),0)
    + COALESCE(length(CAST(extensions.releases AS BLOB)),0)
    + COALESCE(length(CAST(extensions.website AS BLOB)),0)
    + COALESCE(length(CAST(extensions.license AS BLOB)),0)
    + COALESCE(length(CAST(extensions.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(extensions.readme AS BLOB)),0)
    + COALESCE(length(CAST(extensions.source AS BLOB)),0)
    + COALESCE(length(CAST(extensions.version AS BLOB)),0)
    + COALESCE(length(CAST(extensions.download_url AS BLOB)),0);
ALTER TABLE extension_revisions ADD COLUMN content_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE extension_revisions SET content_bytes = length(CAST(content AS BLOB));
ALTER TABLE extension_revisions ADD COLUMN content_hash TEXT;
ALTER TABLE extension_revisions ADD COLUMN compacted_at TEXT;
ALTER TABLE extension_revisions ADD COLUMN summary_name TEXT;
ALTER TABLE extension_revisions ADD COLUMN summary_version TEXT;
ALTER TABLE extension_revisions ADD COLUMN summary_description TEXT;
UPDATE extension_revisions SET summary_name = CASE WHEN content_bytes <= 262144 AND json_valid(content)
      THEN CASE WHEN json_type(content,'$.name')='text' THEN substr(json_extract(content,'$.name'),1,120) ELSE NULL END
      ELSE NULL END,
    summary_version = CASE WHEN content_bytes <= 262144 AND json_valid(content)
      THEN CASE WHEN json_type(content,'$.version')='text' THEN substr(json_extract(content,'$.version'),1,100) ELSE NULL END
      ELSE NULL END,
    summary_description = CASE WHEN content_bytes <= 262144 AND json_valid(content)
      THEN CASE WHEN json_type(content,'$.description')='text' THEN substr(json_extract(content,'$.description'),1,4000) ELSE NULL END
      ELSE NULL END;

UPDATE extensions SET created_by = COALESCE(
  (SELECT submitted_by FROM extension_revisions r WHERE r.extension_id = extensions.id ORDER BY created_at, id LIMIT 1),
  (SELECT owner_user_id FROM developers d WHERE d.id = extensions.developer_id)
);
CREATE TABLE extension_resource_usage (
  scope TEXT NOT NULL, subject TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
  extensions INTEGER NOT NULL DEFAULT 0, revisions INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_extension_resource_usage_subject ON extension_resource_usage(scope,subject);
CREATE TABLE extension_write_events (
  id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL,
  developer_id TEXT NOT NULL, occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_extension_write_events_account ON extension_write_events(account_id,occurred_at);
CREATE INDEX idx_extension_write_events_developer ON extension_write_events(developer_id,occurred_at);
CREATE INDEX idx_extension_write_events_time ON extension_write_events(occurred_at);

--> statement-breakpoint
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
SELECT 'global', 'all', COALESCE(SUM(t.published_bytes),0), COUNT(*), 0
FROM extensions t GROUP BY 'all'
ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes, extensions=extensions+excluded.extensions, revisions=revisions+excluded.revisions;
--> statement-breakpoint
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
SELECT 'account', COALESCE(t.created_by,'legacy'), COALESCE(SUM(t.published_bytes),0), COUNT(*), 0
FROM extensions t GROUP BY COALESCE(t.created_by,'legacy')
ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes, extensions=extensions+excluded.extensions, revisions=revisions+excluded.revisions;
--> statement-breakpoint
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
SELECT 'developer', t.developer_id, COALESCE(SUM(t.published_bytes),0), COUNT(*), 0
FROM extensions t GROUP BY t.developer_id
ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes, extensions=extensions+excluded.extensions, revisions=revisions+excluded.revisions;
--> statement-breakpoint
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
SELECT 'global', 'all', COALESCE(SUM(t.content_bytes),0), 0, COUNT(*)
FROM extension_revisions t GROUP BY 'all'
ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes, extensions=extensions+excluded.extensions, revisions=revisions+excluded.revisions;
--> statement-breakpoint
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
SELECT 'account', t.submitted_by, COALESCE(SUM(t.content_bytes),0), 0, COUNT(*)
FROM extension_revisions t GROUP BY t.submitted_by
ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes, extensions=extensions+excluded.extensions, revisions=revisions+excluded.revisions;
--> statement-breakpoint
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
SELECT 'developer', t.developer_id, COALESCE(SUM(t.content_bytes),0), 0, COUNT(*)
FROM extension_revisions t GROUP BY t.developer_id
ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes, extensions=extensions+excluded.extensions, revisions=revisions+excluded.revisions;
--> statement-breakpoint
INSERT INTO extension_resource_usage(scope,subject) VALUES ('global','all')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER resource_extensions_insert AFTER INSERT ON extensions BEGIN
  INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
  SELECT scope, subject, COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0), 1, 0
  FROM (
    SELECT 'global' AS scope, 'all' AS subject
    UNION ALL SELECT 'account', COALESCE(NEW.created_by,'legacy')
    UNION ALL SELECT 'developer', NEW.developer_id
  ) WHERE true
  ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes,
    extensions=extensions+excluded.extensions,
    revisions=revisions+excluded.revisions;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM extension_resource_usage
    WHERE ((scope='account' AND subject=COALESCE(NEW.created_by,'legacy'))
        OR (scope='developer' AND subject=NEW.developer_id))
      AND (bytes>26214400 OR extensions>100 OR revisions>1000)
  ) THEN RAISE(ABORT,'extension_resource_quota') END;
END;
--> statement-breakpoint
CREATE TRIGGER resource_extensions_delete AFTER DELETE ON extensions BEGIN
  UPDATE extension_resource_usage
  SET bytes=bytes-(COALESCE(length(CAST(OLD.type AS BLOB)),0)
    + COALESCE(length(CAST(OLD.name AS BLOB)),0)
    + COALESCE(length(CAST(OLD.description AS BLOB)),0)
    + COALESCE(length(CAST(OLD.releases AS BLOB)),0)
    + COALESCE(length(CAST(OLD.website AS BLOB)),0)
    + COALESCE(length(CAST(OLD.license AS BLOB)),0)
    + COALESCE(length(CAST(OLD.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(OLD.readme AS BLOB)),0)
    + COALESCE(length(CAST(OLD.source AS BLOB)),0)
    + COALESCE(length(CAST(OLD.version AS BLOB)),0)
    + COALESCE(length(CAST(OLD.download_url AS BLOB)),0)), extensions=extensions-1
  WHERE (scope='global' AND subject='all')
     OR (scope='account' AND subject=COALESCE(OLD.created_by,'legacy'))
     OR (scope='developer' AND subject=OLD.developer_id);
END;
--> statement-breakpoint
-- Internal byte/summary synchronization must not create usage a second time.
-- Account only updates of the actual charged fields.
CREATE TRIGGER resource_extensions_update AFTER UPDATE OF type,name,description,releases,website,license,icon_url,readme,source,version,download_url ON extensions BEGIN
  UPDATE extension_resource_usage
  SET bytes = bytes + (COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) - (COALESCE(length(CAST(OLD.type AS BLOB)),0)
    + COALESCE(length(CAST(OLD.name AS BLOB)),0)
    + COALESCE(length(CAST(OLD.description AS BLOB)),0)
    + COALESCE(length(CAST(OLD.releases AS BLOB)),0)
    + COALESCE(length(CAST(OLD.website AS BLOB)),0)
    + COALESCE(length(CAST(OLD.license AS BLOB)),0)
    + COALESCE(length(CAST(OLD.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(OLD.readme AS BLOB)),0)
    + COALESCE(length(CAST(OLD.source AS BLOB)),0)
    + COALESCE(length(CAST(OLD.version AS BLOB)),0)
    + COALESCE(length(CAST(OLD.download_url AS BLOB)),0))
  WHERE (scope='global' AND subject='all')
     OR (scope='account' AND subject=COALESCE(NEW.created_by,'legacy'))
     OR (scope='developer' AND subject=NEW.developer_id);
  SELECT CASE WHEN (COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) > (COALESCE(length(CAST(OLD.type AS BLOB)),0)
    + COALESCE(length(CAST(OLD.name AS BLOB)),0)
    + COALESCE(length(CAST(OLD.description AS BLOB)),0)
    + COALESCE(length(CAST(OLD.releases AS BLOB)),0)
    + COALESCE(length(CAST(OLD.website AS BLOB)),0)
    + COALESCE(length(CAST(OLD.license AS BLOB)),0)
    + COALESCE(length(CAST(OLD.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(OLD.readme AS BLOB)),0)
    + COALESCE(length(CAST(OLD.source AS BLOB)),0)
    + COALESCE(length(CAST(OLD.version AS BLOB)),0)
    + COALESCE(length(CAST(OLD.download_url AS BLOB)),0)) AND EXISTS (
    SELECT 1 FROM extension_resource_usage
    WHERE ((scope='account' AND subject=COALESCE(NEW.created_by,'legacy'))
        OR (scope='developer' AND subject=NEW.developer_id))
      AND (bytes>26214400 OR extensions>100 OR revisions>1000)
  )
  THEN RAISE(ABORT,'extension_resource_quota') END;
END;
--> statement-breakpoint
CREATE TRIGGER resource_extension_revisions_insert AFTER INSERT ON extension_revisions BEGIN
  INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
  SELECT scope, subject, length(CAST(NEW.content AS BLOB)), 0, 1
  FROM (
    SELECT 'global' AS scope, 'all' AS subject
    UNION ALL SELECT 'account', NEW.submitted_by
    UNION ALL SELECT 'developer', NEW.developer_id
  ) WHERE true
  ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes,
    extensions=extensions+excluded.extensions,
    revisions=revisions+excluded.revisions;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM extension_resource_usage
    WHERE ((scope='account' AND subject=NEW.submitted_by)
        OR (scope='developer' AND subject=NEW.developer_id))
      AND (bytes>26214400 OR extensions>100 OR revisions>1000)
  ) THEN RAISE(ABORT,'extension_resource_quota') END;
END;
--> statement-breakpoint
CREATE TRIGGER resource_extension_revisions_delete AFTER DELETE ON extension_revisions BEGIN
  UPDATE extension_resource_usage
  SET bytes=bytes-(length(CAST(OLD.content AS BLOB))), revisions=revisions-1
  WHERE (scope='global' AND subject='all')
     OR (scope='account' AND subject=OLD.submitted_by)
     OR (scope='developer' AND subject=OLD.developer_id);
END;
--> statement-breakpoint
CREATE TRIGGER resource_extension_revisions_update AFTER UPDATE OF content ON extension_revisions
WHEN NEW.submitted_by=OLD.submitted_by AND NEW.developer_id=OLD.developer_id BEGIN
  UPDATE extension_resource_usage
  SET bytes = bytes + length(CAST(NEW.content AS BLOB)) - length(CAST(OLD.content AS BLOB))
  WHERE (scope='global' AND subject='all')
     OR (scope='account' AND subject=NEW.submitted_by)
     OR (scope='developer' AND subject=NEW.developer_id);
  SELECT CASE WHEN length(CAST(NEW.content AS BLOB)) > length(CAST(OLD.content AS BLOB)) AND EXISTS (
    SELECT 1 FROM extension_resource_usage
    WHERE ((scope='account' AND subject=NEW.submitted_by)
        OR (scope='developer' AND subject=NEW.developer_id))
      AND (bytes>26214400 OR extensions>100 OR revisions>1000)
  )
  THEN RAISE(ABORT,'extension_resource_quota') END;
END;
--> statement-breakpoint
CREATE TRIGGER resource_extension_revisions_identity_update AFTER UPDATE OF submitted_by,developer_id ON extension_revisions
WHEN NEW.submitted_by IS NOT OLD.submitted_by OR NEW.developer_id IS NOT OLD.developer_id BEGIN
UPDATE extension_resource_usage SET bytes=bytes+((length(CAST(OLD.content AS BLOB))) * -1), revisions=revisions+(-1)
  WHERE scope='global' AND subject='all';
UPDATE extension_resource_usage SET bytes=bytes+((length(CAST(OLD.content AS BLOB))) * -1), revisions=revisions+(-1)
  WHERE scope='account' AND subject=OLD.submitted_by;
UPDATE extension_resource_usage SET bytes=bytes+((length(CAST(OLD.content AS BLOB))) * -1), revisions=revisions+(-1)
  WHERE scope='developer' AND subject=OLD.developer_id;
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions) VALUES ('global','all',(length(CAST(NEW.content AS BLOB))),0,1)
  ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes,extensions=extensions+excluded.extensions,revisions=revisions+excluded.revisions;
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions) VALUES ('account',NEW.submitted_by,(length(CAST(NEW.content AS BLOB))),0,1)
  ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes,extensions=extensions+excluded.extensions,revisions=revisions+excluded.revisions;
SELECT CASE WHEN ((length(CAST(NEW.content AS BLOB))) > (length(CAST(OLD.content AS BLOB)))) AND EXISTS (SELECT 1 FROM extension_resource_usage
  WHERE scope='account' AND subject=NEW.submitted_by AND (bytes>26214400 OR extensions>100 OR revisions>1000))
  THEN RAISE(ABORT,'extension_resource_quota') END;
INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions) VALUES ('developer',NEW.developer_id,(length(CAST(NEW.content AS BLOB))),0,1)
  ON CONFLICT(scope,subject) DO UPDATE SET
    bytes=bytes+excluded.bytes,extensions=extensions+excluded.extensions,revisions=revisions+excluded.revisions;
SELECT CASE WHEN ((length(CAST(NEW.content AS BLOB))) > (length(CAST(OLD.content AS BLOB)))) AND EXISTS (SELECT 1 FROM extension_resource_usage
  WHERE scope='developer' AND subject=NEW.developer_id AND (bytes>26214400 OR extensions>100 OR revisions>1000))
  THEN RAISE(ABORT,'extension_resource_quota') END;
END;
--> statement-breakpoint
-- A rolling-day ledger, separate from revisions: withdrawal and review do
-- not refund allowance. CURRENT_TIMESTAMP is supplied by the server. The
-- event uses created_at so historical fixture/import writes keep their age.
CREATE TRIGGER extension_revision_admission BEFORE INSERT ON extension_revisions BEGIN
  SELECT CASE WHEN length(CAST(NEW.content AS BLOB)) > 262144

  THEN RAISE(ABORT,'extension_content_size') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM extension_write_events WHERE account_id=NEW.submitted_by AND occurred_at>unixepoch()-60)>=5
    OR (SELECT COUNT(*) FROM extension_write_events WHERE developer_id=NEW.developer_id AND occurred_at>unixepoch()-60)>=5

  THEN RAISE(ABORT,'extension_write_rate_minute') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM extension_write_events WHERE account_id=NEW.submitted_by AND occurred_at>unixepoch()-86400)>=50
    OR (SELECT COUNT(*) FROM extension_write_events WHERE developer_id=NEW.developer_id AND occurred_at>unixepoch()-86400)>=50

  THEN RAISE(ABORT,'extension_write_rate_day') END;
END;
CREATE TRIGGER extension_revision_write_event AFTER INSERT ON extension_revisions BEGIN
  INSERT INTO extension_write_events(id,account_id,developer_id,occurred_at)
  VALUES (NEW.id,NEW.submitted_by,NEW.developer_id,unixepoch(NEW.created_at));
END;
CREATE TRIGGER extension_revision_content_bound BEFORE UPDATE OF content ON extension_revisions
WHEN length(CAST(NEW.content AS BLOB)) > 262144 AND length(CAST(NEW.content AS BLOB)) > length(CAST(OLD.content AS BLOB))
BEGIN SELECT RAISE(ABORT,'extension_content_size'); END;
CREATE TRIGGER extension_resource_identity BEFORE UPDATE OF created_by,developer_id ON extensions
WHEN NEW.created_by IS NOT OLD.created_by OR NEW.developer_id IS NOT OLD.developer_id
BEGIN SELECT RAISE(ABORT,'extension_resource_identity'); END;

--> statement-breakpoint
CREATE TRIGGER sync_extensions_bytes_insert AFTER INSERT ON extensions
WHEN NEW.published_bytes != (COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) BEGIN
  UPDATE extensions SET published_bytes=(COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0))
  WHERE id=NEW.id;
END;

--> statement-breakpoint
CREATE TRIGGER sync_extensions_bytes_update AFTER UPDATE OF type,name,description,releases,website,license,icon_url,readme,source,version,download_url,published_bytes ON extensions
WHEN NEW.published_bytes != (COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) BEGIN
  UPDATE extensions SET published_bytes=(COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0))
  WHERE id=NEW.id;
END;

--> statement-breakpoint
CREATE TRIGGER sync_extension_revisions_bytes_insert AFTER INSERT ON extension_revisions
WHEN NEW.content_bytes != (length(CAST(NEW.content AS BLOB))) BEGIN
  UPDATE extension_revisions SET content_bytes=(length(CAST(NEW.content AS BLOB)))
  WHERE id=NEW.id;
END;

--> statement-breakpoint
CREATE TRIGGER sync_extension_revisions_bytes_update AFTER UPDATE OF content,content_bytes ON extension_revisions
WHEN NEW.content_bytes != (length(CAST(NEW.content AS BLOB))) BEGIN
  UPDATE extension_revisions SET content_bytes=(length(CAST(NEW.content AS BLOB)))
  WHERE id=NEW.id;
END;

--> statement-breakpoint
CREATE TRIGGER sync_revision_summary_insert AFTER INSERT ON extension_revisions
WHEN NEW.compacted_at IS NULL BEGIN
  UPDATE extension_revisions SET summary_name = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.name')='text' THEN substr(json_extract(NEW.content,'$.name'),1,120) ELSE NULL END
      ELSE NULL END,
    summary_version = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.version')='text' THEN substr(json_extract(NEW.content,'$.version'),1,100) ELSE NULL END
      ELSE NULL END,
    summary_description = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.description')='text' THEN substr(json_extract(NEW.content,'$.description'),1,4000) ELSE NULL END
      ELSE NULL END
  WHERE id=NEW.id;
END;

--> statement-breakpoint
CREATE TRIGGER sync_revision_summary_update AFTER UPDATE OF content ON extension_revisions
WHEN NEW.compacted_at IS NULL BEGIN
  UPDATE extension_revisions SET summary_name = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.name')='text' THEN substr(json_extract(NEW.content,'$.name'),1,120) ELSE NULL END
      ELSE NULL END,
    summary_version = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.version')='text' THEN substr(json_extract(NEW.content,'$.version'),1,100) ELSE NULL END
      ELSE NULL END,
    summary_description = CASE WHEN length(CAST(NEW.content AS BLOB)) <= 262144 AND json_valid(NEW.content)
      THEN CASE WHEN json_type(NEW.content,'$.description')='text' THEN substr(json_extract(NEW.content,'$.description'),1,4000) ELSE NULL END
      ELSE NULL END
  WHERE id=NEW.id;
END;

--> statement-breakpoint
CREATE INDEX idx_extensions_published_revision ON extensions(published_revision_id);
--> statement-breakpoint
CREATE INDEX idx_extension_revisions_retention ON extension_revisions(compacted_at,status,reviewed_at,id);
