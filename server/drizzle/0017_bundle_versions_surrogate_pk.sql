PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_bundle_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`public_id` text,
	`current_version_id` text NOT NULL,
	`previous_version_id` text,
	`machine_id` text NOT NULL,
	`hash` text NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_size` integer DEFAULT 0 NOT NULL,
	`pushed_at` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`owner_id` text
);
--> statement-breakpoint
INSERT INTO `__new_bundle_versions`(`id`, `prefix`, `public_id`, `current_version_id`, `previous_version_id`, `machine_id`, `hash`, `file_count`, `total_size`, `pushed_at`, `updated_at`, `owner_id`) SELECT lower(hex(randomblob(16))), `prefix`, `public_id`, `current_version_id`, `previous_version_id`, `machine_id`, `hash`, `file_count`, `total_size`, `pushed_at`, `updated_at`, `owner_id` FROM `bundle_versions`;--> statement-breakpoint
DROP TABLE `bundle_versions`;--> statement-breakpoint
ALTER TABLE `__new_bundle_versions` RENAME TO `bundle_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `bundle_versions_public_id_unique` ON `bundle_versions` (`public_id`);--> statement-breakpoint
CREATE INDEX `idx_bundle_versions_current` ON `bundle_versions` (`current_version_id`);--> statement-breakpoint
CREATE INDEX `idx_bundle_versions_pushed_at` ON `bundle_versions` (`pushed_at`);--> statement-breakpoint
CREATE INDEX `idx_bundle_versions_owner` ON `bundle_versions` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bundle_versions_owner_prefix_unq` ON `bundle_versions` (`owner_id`,`prefix`);