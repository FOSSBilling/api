DROP INDEX `idx_package_jobs_fingerprint`;--> statement-breakpoint
DROP INDEX `idx_package_jobs_dispatch`;--> statement-breakpoint
ALTER TABLE `package_jobs` ADD `dispatch_scope` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_package_jobs_fingerprint` ON `package_jobs` (`fingerprint`,`dispatch_scope`) WHERE "package_jobs"."status" != 'failed';--> statement-breakpoint
CREATE INDEX `idx_package_jobs_dispatch` ON `package_jobs` (`dispatch_scope`,`status`,`enqueued_at`);