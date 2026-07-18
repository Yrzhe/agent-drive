DROP INDEX `contacts_name_unique`;--> statement-breakpoint
DROP INDEX `contacts_url_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_owner_name_unq` ON `contacts` (`owner_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_owner_url_unq` ON `contacts` (`owner_id`,`url`);--> statement-breakpoint
DROP INDEX `files_path_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `files_owner_path_unq` ON `files` (`owner_id`,`path`);--> statement-breakpoint
DROP INDEX `memories_key_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `memories_owner_key_unq` ON `memories` (`owner_id`,`key`);