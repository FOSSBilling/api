CREATE TABLE `package_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`owner` text NOT NULL,
	`manifest` text NOT NULL,
	`source_id` text,
	`upload_object_id` text,
	`upload_sha256` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`lease_until` text,
	`artifact_id` text,
	`error_code` text,
	`error_message` text,
	`error_status` integer,
	`enqueued_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`upload_object_id`) REFERENCES `package_objects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `package_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "package_jobs_status_check" CHECK("package_jobs"."status" IN ('queued','processing','ready','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_jobs_fingerprint` ON `package_jobs` (`fingerprint`) WHERE "package_jobs"."status" != 'failed';--> statement-breakpoint
CREATE INDEX `idx_package_jobs_owner` ON `package_jobs` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_package_jobs_dispatch` ON `package_jobs` (`status`,`enqueued_at`);
--> statement-breakpoint
CREATE INDEX `idx_package_jobs_upload_object` ON `package_jobs` (`upload_object_id`);
