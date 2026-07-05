CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text,
	`content` text NOT NULL,
	`tags` text,
	`source` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_key_unique` ON `memories` (`key`);--> statement-breakpoint
CREATE INDEX `idx_memories_updated_at` ON `memories` (`updated_at`);--> statement-breakpoint
CREATE VIRTUAL TABLE `memories_fts` USING fts5(`id` UNINDEXED, `content`, `tags`);