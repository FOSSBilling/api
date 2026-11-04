-- Preserve physical website/license storage for v1, while v2 exposes manifest names.
-- Reviewed revision bodies remain an audit log in their original format.
-- Block before changing data; run db/manifest-preflight.sql for the affected
-- extension IDs and release indexes, correct those rows, then retry.
CREATE VIEW _manifest_migration_issues AS
WITH published AS (
  SELECT e.*, d.name AS author_name, d.url AS author_url,
    CASE WHEN json_valid(e.license) THEN CASE json_type(e.license)
      WHEN 'text' THEN json_extract(e.license,'$')
      WHEN 'object' THEN CASE
        WHEN json_type(e.license,'$.spdx_id') = 'text' THEN json_extract(e.license,'$.spdx_id')
        WHEN json_type(e.license,'$.spdx_id') IS NULL OR json_type(e.license,'$.spdx_id') = 'null'
          THEN CASE WHEN json_type(e.license,'$.name') = 'text' THEN json_extract(e.license,'$.name') END
      END END END AS manifest_license
  FROM extensions e JOIN developers d ON d.id = e.developer_id
  WHERE e.published_at IS NOT NULL
), release_rows AS (
  SELECT p.id, r.key AS release_index, r.type AS release_type,
    CASE WHEN r.type = 'object' THEN r.value ELSE '{}' END AS release
  FROM published p, json_each(CASE WHEN json_valid(p.releases) THEN p.releases ELSE '[]' END) r
)
SELECT p.id, NULL AS release_index, problem.value AS issue
FROM published p, json_each(json_array(
  CASE WHEN p.type NOT IN ('mod','module','theme','payment-gateway','server-manager','domain-registrar','translation')
    THEN 'type: choose a supported manifest type (mod will become module)' END,
  CASE WHEN p.manifest_license IS NULL OR length(trim(p.manifest_license)) NOT BETWEEN 1 AND 1000 OR p.manifest_license GLOB '*[^A-Za-z0-9.()+_: |-]*'
    THEN 'license: supply a valid manifest license string or legacy spdx_id/name' END,
  CASE WHEN length(trim(p.author_name)) = 0 OR length(p.author_name) > 200
    OR (p.author_url IS NOT NULL AND p.author_url != '' AND (length(p.author_url) > 2048 OR (p.author_url NOT LIKE 'https://%' AND p.author_url NOT LIKE 'http://%')))
    THEN 'author: correct the developer name/URL before copying package attribution' END,
  CASE WHEN CASE WHEN NOT json_valid(p.releases) THEN 1 WHEN json_type(p.releases) != 'array' THEN 1 ELSE json_array_length(p.releases) NOT BETWEEN 1 AND 100 END
    THEN 'releases: supply a non-empty JSON array with at most 100 releases' END,
  CASE WHEN (SELECT COUNT(*) FROM release_rows r WHERE r.id=p.id AND json_extract(r.release,'$.tag') IN (p.version,'v'||p.version)) != 1
    THEN 'version: identify exactly one current release matching version or v+version' END
)) problem WHERE problem.value IS NOT NULL
UNION ALL
SELECT id, release_index, 'requires: set explicit FOSSBilling and PHP constraints for this release; missing values are not guessed'
FROM release_rows WHERE release_type != 'object'
  OR COALESCE(json_type(release,'$.requires'),'') != 'object'
  OR COALESCE(json_type(release,'$.requires.fossbilling'),'') != 'text'
  OR COALESCE(json_type(release,'$.requires.php'),'') != 'text'
  OR COALESCE(length(trim(json_extract(release,'$.requires.fossbilling'))),0) NOT BETWEEN 1 AND 1000
  OR COALESCE(length(trim(json_extract(release,'$.requires.php'))),0) NOT BETWEEN 1 AND 1000
  OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(release,'$.requires') = 'object' THEN json_extract(release,'$.requires') ELSE '{}' END)
    WHERE key NOT IN ('fossbilling','php','modules'))
  OR (json_type(release,'$.requires.modules') IS NOT NULL AND json_type(release,'$.requires.modules') != 'object')
  OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(release,'$.requires.modules') = 'object' THEN json_extract(release,'$.requires.modules') ELSE '{}' END)
    WHERE key = '' OR key GLOB '*[^a-z0-9_-]*' OR type != 'text' OR length(trim(value)) NOT BETWEEN 1 AND 1000)
ORDER BY id, release_index, issue;
--> statement-breakpoint
CREATE TABLE _manifest_migration_check (
  invalid_count INTEGER CONSTRAINT manifest_data_requires_manual_correction CHECK (invalid_count = 0)
);
--> statement-breakpoint
INSERT INTO _manifest_migration_check SELECT COUNT(*) FROM _manifest_migration_issues;
--> statement-breakpoint
DROP TABLE _manifest_migration_check;
--> statement-breakpoint
DROP VIEW _manifest_migration_issues;
--> statement-breakpoint
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
  type = CASE WHEN type = 'mod' THEN 'module' ELSE type END,
  license = json_quote(CASE WHEN json_type(license) = 'object'
    THEN COALESCE(json_extract(license,'$.spdx_id'),json_extract(license,'$.name'))
    ELSE json_extract(license,'$') END),
  manifest = json_object(
    'manifest_version', 1,
    'author', json((SELECT CASE WHEN url IS NULL OR url = '' THEN json_object('name',name) ELSE json_object('name',name,'url',url) END FROM developers WHERE developers.id=extensions.developer_id)),
    'requires', json((SELECT json_extract(value,'$.requires') FROM json_each(extensions.releases)
      WHERE json_extract(value,'$.tag') IN (extensions.version,'v'||extensions.version)))
  )
WHERE published_at IS NOT NULL;
--> statement-breakpoint
-- Requirements have been explicitly reviewed. Remove only the obsolete v1 field.
UPDATE extensions SET releases = (
  SELECT json_group_array(json(json_remove(value,'$.min_fossbilling_version')))
  FROM json_each(extensions.releases)
) WHERE published_at IS NOT NULL;
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
