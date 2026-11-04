CREATE TABLE `publisher_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`developer_id` text NOT NULL,
	`service_user_id` text NOT NULL,
	`can_publish` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`developer_id`) REFERENCES `developers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_publisher_clients_developer` ON `publisher_clients` (`developer_id`);