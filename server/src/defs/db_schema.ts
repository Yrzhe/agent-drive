import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    path: text("path").notNull().unique(),
    parentPath: text("parent_path").notNull().default("/"),
    isFolder: integer("is_folder").notNull().default(0),
    size: integer("size").notNull().default(0),
    contentType: text("content_type"),
    s3Uri: text("s3_uri"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_files_parent_path").on(table.parentPath)]
);

export const shares = sqliteTable(
  "shares",
  {
    id: text("id").primaryKey(),
    fileId: text("file_id").references(() => files.id, { onDelete: "cascade" }),
    folderPath: text("folder_path"),
    passwordHash: text("password_hash"),
    maxDownloads: integer("max_downloads"),
    downloadCount: integer("download_count").notNull().default(0),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_shares_file_id").on(table.fileId),
    index("idx_shares_folder_path").on(table.folderPath),
  ]
);

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetPath: text("target_path"),
    actor: text("actor").notNull(),
    metadata: text("metadata"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_activity_type").on(table.eventType),
    index("idx_activity_created_at").on(table.createdAt),
    index("idx_activity_target").on(table.targetType, table.targetId),
  ]
);

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    eventTypes: text("event_types").notNull(),
    secret: text("secret").notNull(),
    enabled: integer("enabled").notNull().default(1),
    lastTriggeredAt: text("last_triggered_at"),
    lastStatus: integer("last_status"),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_webhooks_enabled").on(table.enabled), index("idx_webhooks_created_at").on(table.createdAt)]
);
