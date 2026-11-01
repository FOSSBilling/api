CREATE TABLE `m2m_publisher_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`developer_id` text NOT NULL,
	`can_publish` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`developer_id`) REFERENCES `developers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "m2m_publisher_clients_can_publish_check" CHECK("m2m_publisher_clients"."can_publish" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_m2m_publisher_clients_developer` ON `m2m_publisher_clients` (`developer_id`);