CREATE TABLE `bundle_versions` (
	`prefix` text PRIMARY KEY NOT NULL,
	`current_version_id` text NOT NULL,
	`previous_version_id` text,
	`machine_id` text NOT NULL,
	`hash` text NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_size` integer DEFAULT 0 NOT NULL,
	`pushed_at` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bundle_versions_current` ON `bundle_versions` (`current_version_id`);--> statement-breakpoint
CREATE INDEX `idx_bundle_versions_pushed_at` ON `bundle_versions` (`pushed_at`);