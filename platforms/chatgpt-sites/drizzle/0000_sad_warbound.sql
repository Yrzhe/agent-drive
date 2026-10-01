CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`target_path` text,
	`actor` text NOT NULL,
	`metadata` text,
	`ip` text,
	`user_agent` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`owner_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_activity_type` ON `activity_log` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_activity_created_at` ON `activity_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_activity_target` ON `activity_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_activity_owner` ON `activity_log` (`owner_id`);--> statement-breakpoint
CREATE TABLE `agent_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key_jwk` text NOT NULL,
	`private_key_jwk` text NOT NULL,
	`algorithm` text DEFAULT 'Ed25519' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `allowlist` (
	`email` text PRIMARY KEY NOT NULL,
	`added_by` text,
	`added_at` text
);
--> statement-breakpoint
CREATE TABLE `bundle_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`prefix` text NOT NULL,
	`public_id` text,
	`current_version_id` text NOT NULL,
	`previous_version_id` text,
	`machine_id` text NOT NULL,
	`hash` text NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_size` integer DEFAULT 0 NOT NULL,
	`pushed_at` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`owner_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bundle_versions_public_id_unique` ON `bundle_versions` (`public_id`);--> statement-breakpoint
CREATE INDEX `idx_bundle_versions_current` ON `bundle_versions` (`current_version_id`);--> statement-breakpoint
CREATE INDEX `idx_bundle_versions_pushed_at` ON `bundle_versions` (`pushed_at`);--> statement-breakpoint
CREATE INDEX `idx_bundle_versions_owner` ON `bundle_versions` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bundle_versions_owner_prefix_unq` ON `bundle_versions` (`owner_id`,`prefix`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`public_key_jwk` text NOT NULL,
	`algorithm` text DEFAULT 'Ed25519' NOT NULL,
	`auto_release` integer DEFAULT 0 NOT NULL,
	`added_at` text DEFAULT (datetime('now')) NOT NULL,
	`owner_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_contacts_owner` ON `contacts` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_owner_name_unq` ON `contacts` (`owner_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_owner_url_unq` ON `contacts` (`owner_id`,`url`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`parent_path` text DEFAULT '/' NOT NULL,
	`is_folder` integer DEFAULT 0 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`content_type` text,
	`s3_uri` text,
	`deleted_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`owner_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_files_parent_path` ON `files` (`parent_path`);--> statement-breakpoint
CREATE INDEX `idx_files_deleted_at` ON `files` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_files_owner` ON `files` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_owner_path_unq` ON `files` (`owner_id`,`path`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text,
	`content` text NOT NULL,
	`tags` text,
	`source` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`owner_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_memories_updated_at` ON `memories` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_memories_owner` ON `memories` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `memories_owner_key_unq` ON `memories` (`owner_id`,`key`);--> statement-breakpoint
CREATE TABLE `oauth_authorization_codes` (
	`id` text,
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
CREATE INDEX `idx_oauth_codes_id` ON `oauth_authorization_codes` (`id`);--> statement-breakpoint
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
	`revoked_at` text,
	`source_code_id` text,
	`label` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_access_token_hash_unique` ON `oauth_tokens` (`access_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_refresh_token_hash_unique` ON `oauth_tokens` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_access` ON `oauth_tokens` (`access_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_refresh` ON `oauth_tokens` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_client` ON `oauth_tokens` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_user` ON `oauth_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_source_code` ON `oauth_tokens` (`source_code_id`);--> statement-breakpoint
CREATE INDEX `idx_oauth_tokens_created_at` ON `oauth_tokens` (`created_at`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`first_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
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
CREATE INDEX `idx_registration_intents_email` ON `registration_intents` (`email`);--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text,
	`folder_path` text,
	`password_hash` text,
	`password_version` integer,
	`max_downloads` integer,
	`download_count` integer DEFAULT 0 NOT NULL,
	`expires_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`owner_id` text,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_shares_file_id` ON `shares` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_shares_folder_path` ON `shares` (`folder_path`);--> statement-breakpoint
CREATE INDEX `idx_shares_created_at` ON `shares` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_shares_owner` ON `shares` (`owner_id`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX `idx_spaces_visibility` ON `spaces` (`visibility`);--> statement-breakpoint
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
CREATE INDEX `idx_user_access_status` ON `user_access` (`status`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`event_types` text NOT NULL,
	`secret` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_triggered_at` text,
	`last_status` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`owner_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_webhooks_enabled` ON `webhooks` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_webhooks_created_at` ON `webhooks` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_webhooks_owner` ON `webhooks` (`owner_id`);--> statement-breakpoint
CREATE TABLE `sites_users` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_users_subject_unique` ON `sites_users` (`subject`);--> statement-breakpoint
CREATE TABLE `sites_upload_parts` (
	`session_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`etag` text NOT NULL,
	`size` integer NOT NULL,
	PRIMARY KEY(`session_id`, `part_number`)
);
--> statement-breakpoint
CREATE TABLE `sites_upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`expected_size` integer NOT NULL,
	`upload_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL
);
