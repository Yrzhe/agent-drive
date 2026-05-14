ALTER TABLE `files` ADD `deleted_at` text;--> statement-breakpoint
CREATE INDEX `idx_files_deleted_at` ON `files` (`deleted_at`);