CREATE TABLE `oauth_authorization_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`pkce_challenge` text NOT NULL,
	`pkce_method` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_oauth_codes_client` ON `oauth_authorization_codes` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_codes_expires` ON `oauth_authorization_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_secret_hash` text,
	`redirect_uris` text NOT NULL,
	`client_name` text,
	`scope_default` text,
	`registered_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`access_token_hash` text NOT NULL,
	`refresh_token_hash` text,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` text NOT NULL,
	`refresh_expires_at` text,
	`created_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_access_token_hash_unique` ON `oauth_tokens` (`access_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_refresh_token_hash_unique` ON `oauth_tokens` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_access` ON `oauth_tokens` (`access_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_refresh` ON `oauth_tokens` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_client` ON `oauth_tokens` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_user` ON `oauth_tokens` (`user_id`);