CREATE INDEX `idx_sites_upload_expiry` ON `sites_upload_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_sites_upload_file` ON `sites_upload_sessions` (`file_id`);