ALTER TABLE `activity_log` ADD `owner_id` text;--> statement-breakpoint
CREATE INDEX `idx_activity_owner` ON `activity_log` (`owner_id`);--> statement-breakpoint
ALTER TABLE `bundle_versions` ADD `owner_id` text;--> statement-breakpoint
CREATE INDEX `idx_bundle_versions_owner` ON `bundle_versions` (`owner_id`);--> statement-breakpoint
ALTER TABLE `contacts` ADD `owner_id` text;--> statement-breakpoint
CREATE INDEX `idx_contacts_owner` ON `contacts` (`owner_id`);--> statement-breakpoint
ALTER TABLE `files` ADD `owner_id` text;--> statement-breakpoint
CREATE INDEX `idx_files_owner` ON `files` (`owner_id`);--> statement-breakpoint
ALTER TABLE `memories` ADD `owner_id` text;--> statement-breakpoint
CREATE INDEX `idx_memories_owner` ON `memories` (`owner_id`);--> statement-breakpoint
ALTER TABLE `shares` ADD `owner_id` text;--> statement-breakpoint
CREATE INDEX `idx_shares_owner` ON `shares` (`owner_id`);--> statement-breakpoint
ALTER TABLE `webhooks` ADD `owner_id` text;--> statement-breakpoint
CREATE INDEX `idx_webhooks_owner` ON `webhooks` (`owner_id`);