CREATE TABLE `registration_intents` (
	`token` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`ref` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_registration_intents_email` ON `registration_intents` (`email`);