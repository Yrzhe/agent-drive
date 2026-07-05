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
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_files_parent_path").on(table.parentPath),
    index("idx_files_deleted_at").on(table.deletedAt),
  ]
);

export const shares = sqliteTable(
  "shares",
  {
    id: text("id").primaryKey(),
    fileId: text("file_id").references(() => files.id, { onDelete: "cascade" }),
    folderPath: text("folder_path"),
    passwordHash: text("password_hash"),
    passwordVersion: integer("password_version"),
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
    ip: text("ip"),
    userAgent: text("user_agent"),
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

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    key: text("key").unique(),
    content: text("content").notNull(),
    tags: text("tags"),
    source: text("source"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_memories_updated_at").on(table.updatedAt)]
);

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  firstAt: integer("first_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientSecretHash: text("client_secret_hash"),
  redirectUris: text("redirect_uris").notNull(),
  clientName: text("client_name"),
  scopeDefault: text("scope_default"),
  registeredAt: text("registered_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

export const oauthAuthorizationCodes = sqliteTable(
  "oauth_authorization_codes",
  {
    id: text("id"),
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id").notNull(),
    scope: text("scope").notNull(),
    pkceChallenge: text("pkce_challenge").notNull(),
    pkceMethod: text("pkce_method").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
  },
  (table) => [
    index("idx_oauth_codes_id").on(table.id),
    index("idx_oauth_codes_client").on(table.clientId),
    index("idx_oauth_codes_expires").on(table.expiresAt),
  ]
);

export const bundleVersions = sqliteTable(
  "bundle_versions",
  {
    prefix: text("prefix").primaryKey(),
    currentVersionId: text("current_version_id").notNull(),
    previousVersionId: text("previous_version_id"),
    machineId: text("machine_id").notNull(),
    hash: text("hash").notNull(),
    fileCount: integer("file_count").notNull().default(0),
    totalSize: integer("total_size").notNull().default(0),
    pushedAt: text("pushed_at").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_bundle_versions_current").on(table.currentVersionId),
    index("idx_bundle_versions_pushed_at").on(table.pushedAt),
  ]
);

export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    refreshTokenHash: text("refresh_token_hash").unique(),
    clientId: text("client_id").notNull(),
    userId: text("user_id").notNull(),
    scope: text("scope").notNull(),
    expiresAt: text("expires_at").notNull(),
    refreshExpiresAt: text("refresh_expires_at"),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
    sourceCodeId: text("source_code_id"),
  },
  (table) => [
    index("idx_oauth_tokens_access").on(table.accessTokenHash),
    index("idx_oauth_tokens_refresh").on(table.refreshTokenHash),
    index("idx_oauth_tokens_client").on(table.clientId),
    index("idx_oauth_tokens_user").on(table.userId),
    index("idx_oauth_tokens_source_code").on(table.sourceCodeId),
  ]
);
