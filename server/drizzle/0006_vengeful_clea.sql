ALTER TABLE `oauth_authorization_codes` ADD `id` text;--> statement-breakpoint
CREATE INDEX `idx_oauth_codes_id` ON `oauth_authorization_codes` (`id`);--> statement-breakpoint
ALTER TABLE `oauth_tokens` ADD `source_code_id` text;--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_source_code` ON `oauth_tokens` (`source_code_id`);