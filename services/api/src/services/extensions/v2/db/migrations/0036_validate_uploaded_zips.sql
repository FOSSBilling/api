ALTER TABLE package_uploads RENAME COLUMN manifest TO target;
--> statement-breakpoint
ALTER TABLE package_jobs RENAME COLUMN manifest TO target;
--> statement-breakpoint
UPDATE package_uploads SET target=json_object('id',json_extract(target,'$.id'),'version',json_extract(target,'$.version'));
--> statement-breakpoint
UPDATE package_jobs SET target=json_object('id',json_extract(target,'$.id'),'version',json_extract(target,'$.version'));
--> statement-breakpoint
ALTER TABLE package_jobs DROP COLUMN source_id;
--> statement-breakpoint
DROP INDEX idx_package_source_version;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_package_source_version ON package_sources (profile_generation,extension_identifier,version,sha256);
--> statement-breakpoint
DROP INDEX idx_package_artifact_manifest;
--> statement-breakpoint
DROP TRIGGER package_artifacts_immutable;
--> statement-breakpoint
ALTER TABLE package_artifacts DROP COLUMN manifest_hash;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_package_artifact_checksum ON package_artifacts (source_id,sha256);
--> statement-breakpoint
CREATE TRIGGER package_artifacts_immutable BEFORE UPDATE OF id,source_id,manifest,sha256,object_id,download_url,created_at ON package_artifacts
BEGIN SELECT RAISE(ABORT, 'package_artifact_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER package_release_publication_locked BEFORE UPDATE OF published_revision_id ON extensions
WHEN NEW.published_revision_id IS NOT NULL AND NEW.published_revision_id IS NOT OLD.published_revision_id AND EXISTS (
  SELECT 1 FROM json_each(NEW.releases) release
  JOIN package_sources s ON s.extension_identifier=lower(NEW.identifier)
    AND json_extract(release.value,'$.tag') IN (s.version, 'v' || s.version)
  JOIN package_artifacts a ON a.source_id=s.id AND a.published_at IS NOT NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM package_artifacts selected
    WHERE selected.id=json_extract(release.value,'$.artifact_id') AND selected.published_at IS NOT NULL
  )
)
BEGIN SELECT RAISE(ABORT, 'package_release_published'); END;
