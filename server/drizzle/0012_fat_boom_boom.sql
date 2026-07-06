ALTER TABLE `bundle_versions` ADD `public_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `bundle_versions_public_id_unique` ON `bundle_versions` (`public_id`);