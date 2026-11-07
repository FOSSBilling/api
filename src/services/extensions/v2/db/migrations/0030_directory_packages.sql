CREATE TABLE `package_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`manifest` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`sha256` text NOT NULL,
	`object_id` text NOT NULL,
	`download_url` text NOT NULL,
	`published_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `package_sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`object_id`) REFERENCES `package_objects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_artifact_manifest` ON `package_artifacts` (`source_id`,`manifest_hash`);--> statement-breakpoint
CREATE TABLE `package_objects` (
 `deleting` integer DEFAULT 0 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`created_by` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_package_objects_creator` ON `package_objects` (`created_by`);--> statement-breakpoint
CREATE TABLE `package_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_generation` text NOT NULL,
	`extension_id` text NOT NULL,
	`version` text NOT NULL,
	`sha256` text NOT NULL,
	`object_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`object_id`) REFERENCES `package_objects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_source_version` ON `package_sources` (`profile_generation`,`extension_id`,`version`);
--> statement-breakpoint
CREATE TRIGGER package_sources_immutable BEFORE UPDATE ON package_sources
BEGIN SELECT RAISE(ABORT, 'package_source_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER package_artifacts_immutable BEFORE UPDATE OF id,source_id,manifest,manifest_hash,sha256,object_id,download_url,created_at ON package_artifacts
BEGIN SELECT RAISE(ABORT, 'package_artifact_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER package_artifacts_publication_immutable BEFORE UPDATE OF published_at ON package_artifacts WHEN OLD.published_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'package_publication_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER publish_package_artifacts AFTER UPDATE OF published_revision_id ON extensions
WHEN NEW.published_revision_id IS NOT NULL AND NEW.published_revision_id IS NOT OLD.published_revision_id
BEGIN
  UPDATE package_artifacts SET published_at=CURRENT_TIMESTAMP
  WHERE published_at IS NULL AND id IN (
    SELECT json_extract(value,'$.artifact_id') FROM json_each(NEW.releases)
  ) AND source_id IN (
    SELECT s.id FROM package_sources s JOIN developers d ON d.profile_generation=s.profile_generation
    WHERE lower(s.extension_id)=lower(NEW.id) AND d.id=NEW.developer_id
  );
END;

--> statement-breakpoint
CREATE INDEX idx_package_sources_extension ON package_sources(extension_id);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_package_sources_object ON package_sources(object_id);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_package_artifacts_object ON package_artifacts(object_id);

--> statement-breakpoint
CREATE TABLE `package_icons` (
  `source_id` text PRIMARY KEY NOT NULL,
  `avif_object_id` text,
  `avif_sha256` text,
  `png_object_id` text,
  `png_sha256` text,
  `svg_object_id` text,
  `svg_sha256` text,
  FOREIGN KEY (`source_id`) REFERENCES `package_sources`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`avif_object_id`) REFERENCES `package_objects`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`png_object_id`) REFERENCES `package_objects`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`svg_object_id`) REFERENCES `package_objects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TRIGGER package_icons_immutable BEFORE UPDATE ON package_icons
BEGIN SELECT RAISE(ABORT, 'Package icons are immutable'); END;
