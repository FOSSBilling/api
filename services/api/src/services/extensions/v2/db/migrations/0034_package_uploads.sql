CREATE TABLE `package_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_scope` text NOT NULL,
	`fingerprint` text NOT NULL,
	`manifest` text NOT NULL,
	`owner` text NOT NULL,
	`sha256` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `package_objects`(`id`) ON UPDATE no action ON DELETE cascade
);
