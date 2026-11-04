-- Preserve physical website/license storage for v1, while v2 exposes manifest names.
-- Reviewed revision bodies remain an audit log in their original format.
ALTER TABLE extensions ADD COLUMN manifest TEXT;
--> statement-breakpoint
DROP TRIGGER resource_extensions_insert;
--> statement-breakpoint
CREATE TRIGGER resource_extensions_insert AFTER INSERT ON extensions BEGIN
  INSERT INTO extension_resource_usage(scope,subject,bytes,extensions,revisions)
  SELECT scope, subject, COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
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
DROP TRIGGER resource_extensions_update;
--> statement-breakpoint
CREATE TRIGGER resource_extensions_update AFTER UPDATE OF type,name,description,releases,website,license,icon_url,readme,source,version,download_url,manifest ON extensions BEGIN
  UPDATE extension_resource_usage
  SET bytes = bytes + (COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) - (COALESCE(length(CAST(OLD.manifest AS BLOB)),0)
    + COALESCE(length(CAST(OLD.type AS BLOB)),0)
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
END;
--> statement-breakpoint
DROP TRIGGER sync_extensions_bytes_insert;
--> statement-breakpoint
CREATE TRIGGER sync_extensions_bytes_insert AFTER INSERT ON extensions
WHEN NEW.published_bytes != (COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
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
  UPDATE extensions SET published_bytes=(COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
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
DROP TRIGGER sync_extensions_bytes_update;
--> statement-breakpoint
CREATE TRIGGER sync_extensions_bytes_update AFTER UPDATE OF type,name,description,releases,website,license,icon_url,readme,source,version,download_url,manifest,published_bytes ON extensions
WHEN NEW.published_bytes != (COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
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
  UPDATE extensions SET published_bytes=(COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
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
DROP TRIGGER resource_extensions_delete;
--> statement-breakpoint
CREATE TRIGGER resource_extensions_delete AFTER DELETE ON extensions BEGIN
  UPDATE extension_resource_usage
  SET bytes=bytes-(COALESCE(length(CAST(OLD.manifest AS BLOB)),0) + COALESCE(length(CAST(OLD.type AS BLOB)),0)
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
UPDATE extensions SET
  type = CASE WHEN type IN ('mod','hook') THEN 'module' ELSE type END,
  license = CASE WHEN json_valid(license) THEN
    CASE WHEN json_type(license) = 'object' THEN json_quote(COALESCE(json_extract(license,'$.spdx_id'),json_extract(license,'$.name'),'Unavailable')) ELSE license END
    ELSE json_quote(COALESCE(license,'Unavailable')) END,
  manifest = json_object(
    'manifest_version', 1,
    'author', json((SELECT CASE WHEN url IS NULL OR url = '' THEN json_object('name',name) ELSE json_object('name',name,'url',url) END FROM developers WHERE developers.id=extensions.developer_id)),
    'requires', json_object('fossbilling', COALESCE(
      (SELECT '>=' || json_extract(value,'$.min_fossbilling_version') FROM json_each(CASE WHEN json_valid(extensions.releases) THEN extensions.releases ELSE '[]' END)
       WHERE json_extract(value,'$.min_fossbilling_version') IS NOT NULL
       ORDER BY CASE WHEN json_extract(value,'$.tag') IN (extensions.version,'v'||extensions.version) THEN 0 ELSE 1 END, key LIMIT 1), '*'), 'php','*')
  )
WHERE published_at IS NOT NULL;

--> statement-breakpoint
-- Preserve every release entry while replacing the lossy minimum-version field.
UPDATE extensions SET releases = (
  SELECT json_group_array(json(json_set(json_remove(value,'$.min_fossbilling_version'), '$.requires',
    json(CASE WHEN json_type(value,'$.requires') = 'object' THEN json_extract(value,'$.requires')
      ELSE json_object('fossbilling',CASE WHEN json_extract(value,'$.min_fossbilling_version') IS NOT NULL
        THEN '>=' || json_extract(value,'$.min_fossbilling_version') ELSE '*' END,'php','*') END))))
  FROM json_each(extensions.releases)
) WHERE published_at IS NOT NULL AND json_valid(releases) AND json_type(releases)='array';
--> statement-breakpoint
DROP INDEX idx_extensions_catalogue_order;
--> statement-breakpoint
DROP INDEX idx_extensions_type_catalogue_order;
--> statement-breakpoint
CREATE INDEX idx_extensions_public_order ON extensions (lower(id),id) WHERE published_at IS NOT NULL AND delisted_at IS NULL;
--> statement-breakpoint
CREATE INDEX idx_extensions_type_public_order ON extensions (type,lower(id),id) WHERE published_at IS NOT NULL AND delisted_at IS NULL;

--> statement-breakpoint
-- Enforce growth quotas again after the metadata backfill; pre-existing
-- over-quota collections remain intact and cannot grow through new writes.
DROP TRIGGER resource_extensions_update;
--> statement-breakpoint
CREATE TRIGGER resource_extensions_update AFTER UPDATE OF type,name,description,releases,website,license,icon_url,readme,source,version,download_url,manifest ON extensions BEGIN
  UPDATE extension_resource_usage
  SET bytes = bytes + (COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) - (COALESCE(length(CAST(OLD.manifest AS BLOB)),0)
    + COALESCE(length(CAST(OLD.type AS BLOB)),0)
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
  SELECT CASE WHEN (COALESCE(length(CAST(NEW.manifest AS BLOB)),0)
    + COALESCE(length(CAST(NEW.type AS BLOB)),0)
    + COALESCE(length(CAST(NEW.name AS BLOB)),0)
    + COALESCE(length(CAST(NEW.description AS BLOB)),0)
    + COALESCE(length(CAST(NEW.releases AS BLOB)),0)
    + COALESCE(length(CAST(NEW.website AS BLOB)),0)
    + COALESCE(length(CAST(NEW.license AS BLOB)),0)
    + COALESCE(length(CAST(NEW.icon_url AS BLOB)),0)
    + COALESCE(length(CAST(NEW.readme AS BLOB)),0)
    + COALESCE(length(CAST(NEW.source AS BLOB)),0)
    + COALESCE(length(CAST(NEW.version AS BLOB)),0)
    + COALESCE(length(CAST(NEW.download_url AS BLOB)),0)) > (COALESCE(length(CAST(OLD.manifest AS BLOB)),0)
    + COALESCE(length(CAST(OLD.type AS BLOB)),0)
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
