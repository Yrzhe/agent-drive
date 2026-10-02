import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const driveUsers = sqliteTable("sites_users", {
  id: text("id").primaryKey(),
  subject: text("subject").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const uploadSessions = sqliteTable("sites_upload_sessions", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull(),
  ownerId: text("owner_id").notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  expectedSize: integer("expected_size").notNull(),
  uploadId: text("upload_id"),
  state: text("state").notNull().default("pending"),
  expiresAt: integer("expires_at").notNull(),
  purpose: text("purpose").notNull().default("file"),
  baseUri: text("base_uri"),
  baseUpdatedAt: text("base_updated_at"),
}, (table) => [index("idx_sites_upload_expiry").on(table.expiresAt), index("idx_sites_upload_file").on(table.fileId)]);
export const uploadParts = sqliteTable("sites_upload_parts", {
  sessionId: text("session_id").notNull(),
  partNumber: integer("part_number").notNull(),
  etag: text("etag").notNull(),
  size: integer("size").notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.partNumber] })]);

export const fileVersions = sqliteTable("sites_file_versions", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull(),
  ownerId: text("owner_id").notNull(),
  s3Uri: text("s3_uri").notNull(),
  name: text("name").notNull(),
  size: integer("size").notNull(),
  contentType: text("content_type"),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("idx_sites_version_object").on(table.fileId, table.s3Uri), index("idx_sites_version_file").on(table.fileId, table.createdAt)]);

export const shareVersions = sqliteTable("sites_share_versions", {
  shareId: text("share_id").primaryKey(),
  versionId: text("version_id").notNull(),
}, (table) => [index("idx_sites_share_version").on(table.versionId)]);
