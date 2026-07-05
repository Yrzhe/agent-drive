CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text,
	`content` text NOT NULL,
	`tags` text,
	`source` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_key_unique` ON `memories` (`key`);--> statement-breakpoint
CREATE INDEX `idx_memories_updated_at` ON `memories` (`updated_at`);--> statement-breakpoint
CREATE VIRTUAL TABLE `memories_fts` USING fts5(`content`, `tags`, content='memories', content_rowid='rowid');--> statement-breakpoint
CREATE TRIGGER `memories_fts_ai` AFTER INSERT ON `memories` BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;--> statement-breakpoint
CREATE TRIGGER `memories_fts_ad` AFTER DELETE ON `memories` BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
END;--> statement-breakpoint
CREATE TRIGGER `memories_fts_au` AFTER UPDATE ON `memories` BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;