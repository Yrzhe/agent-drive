CREATE TABLE `sites_file_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`s3_uri` text NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sites_version_object` ON `sites_file_versions` (`file_id`,`s3_uri`);--> statement-breakpoint
CREATE INDEX `idx_sites_version_file` ON `sites_file_versions` (`file_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sites_share_versions` (
	`share_id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sites_share_version` ON `sites_share_versions` (`version_id`);--> statement-breakpoint
ALTER TABLE `sites_upload_sessions` ADD `purpose` text DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE `sites_upload_sessions` ADD `base_uri` text;--> statement-breakpoint
ALTER TABLE `sites_upload_sessions` ADD `base_updated_at` text;