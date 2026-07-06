CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`public_key_jwk` text NOT NULL,
	`algorithm` text DEFAULT 'Ed25519' NOT NULL,
	`auto_release` integer DEFAULT 0 NOT NULL,
	`added_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_name_unique` ON `contacts` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_url_unique` ON `contacts` (`url`);