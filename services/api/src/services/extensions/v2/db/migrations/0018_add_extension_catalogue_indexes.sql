CREATE INDEX `idx_extensions_catalogue_order` ON `extensions` (lower("id"),`id`);--> statement-breakpoint
CREATE INDEX `idx_extensions_type_catalogue_order` ON `extensions` (`type`,lower("id"),`id`);--> statement-breakpoint
CREATE INDEX `idx_extensions_author_catalogue_order` ON `extensions` (`author_id`,lower("id"),`id`);