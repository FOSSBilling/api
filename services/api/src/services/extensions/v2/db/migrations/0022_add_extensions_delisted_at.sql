DROP INDEX `idx_extensions_catalogue_order`;--> statement-breakpoint
DROP INDEX `idx_extensions_type_catalogue_order`;--> statement-breakpoint
ALTER TABLE `extensions` ADD `delisted_at` text;--> statement-breakpoint
ALTER TABLE `extensions` ADD `delist_reason` text;--> statement-breakpoint
CREATE INDEX `idx_extensions_catalogue_order` ON `extensions` (lower("id"),`id`) WHERE "extensions"."published_at" IS NOT NULL AND "extensions"."delisted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_extensions_type_catalogue_order` ON `extensions` (`type`,lower("id"),`id`) WHERE "extensions"."published_at" IS NOT NULL AND "extensions"."delisted_at" IS NULL;