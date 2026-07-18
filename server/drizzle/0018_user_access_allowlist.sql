CREATE TABLE `allowlist` (
	`email` text PRIMARY KEY NOT NULL,
	`added_by` text,
	`added_at` text
);
--> statement-breakpoint
CREATE TABLE `user_access` (
	`user_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`message` text,
	`referred_by` text,
	`applied_at` text,
	`decided_by` text,
	`decided_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_user_access_status` ON `user_access` (`status`);