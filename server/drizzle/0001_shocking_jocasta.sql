CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`target_path` text,
	`actor` text NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_type` ON `activity_log` (`event_type`);--> statement-breakpoint
CREATE INDEX `idx_activity_created_at` ON `activity_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_activity_target` ON `activity_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`event_types` text NOT NULL,
	`secret` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_triggered_at` text,
	`last_status` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_webhooks_enabled` ON `webhooks` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_webhooks_created_at` ON `webhooks` (`created_at`);