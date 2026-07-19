CREATE TABLE `space_items` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`item_type` text NOT NULL,
	`item_ref` text NOT NULL,
	`contributed_by` text NOT NULL,
	`added_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_space_items_space` ON `space_items` (`space_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `space_items_space_type_ref_unq` ON `space_items` (`space_id`,`item_type`,`item_ref`);--> statement-breakpoint
CREATE TABLE `space_members` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_space_members_user` ON `space_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`creator_id` text NOT NULL,
	`visibility` text DEFAULT 'invite' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
