-- IF NOT EXISTS added by hand after drizzle-kit generate: this is the
-- baseline migration for a database that, in local/remote environments
-- that already ran the old init.sql bootstrap, has this table already.
-- Matches the idempotent CREATE TABLE/INDEX convention used by every
-- extensions-v2 migration in the sibling database for the same reason.
CREATE TABLE IF NOT EXISTS `central_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`type` text NOT NULL,
	`dismissible` integer DEFAULT false NOT NULL,
	`min_fossbilling_version` text NOT NULL,
	`max_fossbilling_version` text NOT NULL,
	`include_preview_branch` integer DEFAULT false NOT NULL,
	`buttons` text DEFAULT '[]',
	`datetime` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "central_alerts_type_check" CHECK("central_alerts"."type" IN ('success', 'info', 'warning', 'danger'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_central_alerts_type` ON `central_alerts` (`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_central_alerts_version_range` ON `central_alerts` (`min_fossbilling_version`,`max_fossbilling_version`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_central_alerts_datetime` ON `central_alerts` (`datetime`);