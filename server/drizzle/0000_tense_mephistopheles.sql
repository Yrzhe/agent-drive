CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`parent_path` text DEFAULT '/' NOT NULL,
	`is_folder` integer DEFAULT 0 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`content_type` text,
	`s3_uri` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_path_unique` ON `files` (`path`);--> statement-breakpoint
CREATE INDEX `idx_files_parent_path` ON `files` (`parent_path`);--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text,
	`folder_path` text,
	`password_hash` text,
	`max_downloads` integer,
	`download_count` integer DEFAULT 0 NOT NULL,
	`expires_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_shares_file_id` ON `shares` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_shares_folder_path` ON `shares` (`folder_path`);