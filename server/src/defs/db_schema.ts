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
