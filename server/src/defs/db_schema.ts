import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    parentPath: text("parent_path").notNull().default("/"),
    isFolder: integer("is_folder").notNull().default(0),
    size: integer("size").notNull().default(0),
    contentType: text("content_type"),
    s3Uri: text("s3_uri"),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
    // Multi-tenancy Phase 1a: nullable now (backfilled), required by code from Phase 2.
    ownerId: text("owner_id"),
  },
  (table) => [
    index("idx_files_parent_path").on(table.parentPath),
    index("idx_files_deleted_at").on(table.deletedAt),
    index("idx_files_owner").on(table.ownerId),
    unique("files_owner_path_unq").on(table.ownerId, table.path),
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
    ownerId: text("owner_id"),
  },
  (table) => [
    index("idx_shares_file_id").on(table.fileId),
    index("idx_shares_folder_path").on(table.folderPath),
    index("idx_shares_created_at").on(table.createdAt),
    index("idx_shares_owner").on(table.ownerId),
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
    ownerId: text("owner_id"),
  },
  (table) => [
    index("idx_activity_type").on(table.eventType),
    index("idx_activity_created_at").on(table.createdAt),
    index("idx_activity_target").on(table.targetType, table.targetId),
    index("idx_activity_owner").on(table.ownerId),
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
    ownerId: text("owner_id"),
  },
  (table) => [
    index("idx_webhooks_enabled").on(table.enabled),
    index("idx_webhooks_created_at").on(table.createdAt),
    index("idx_webhooks_owner").on(table.ownerId),
  ]
);

export const agentIdentity = sqliteTable("agent_identity", {
  id: text("id").primaryKey(),
  publicKeyJwk: text("public_key_jwk").notNull(),
  privateKeyJwk: text("private_key_jwk").notNull(),
  algorithm: text("algorithm").notNull().default("Ed25519"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    publicKeyJwk: text("public_key_jwk").notNull(),
    algorithm: text("algorithm").notNull().default("Ed25519"),
    autoRelease: integer("auto_release").notNull().default(0),
    addedAt: text("added_at").notNull().default(sql`(datetime('now'))`),
    ownerId: text("owner_id"),
  },
  (table) => [
    index("idx_contacts_owner").on(table.ownerId),
    unique("contacts_owner_name_unq").on(table.ownerId, table.name),
    unique("contacts_owner_url_unq").on(table.ownerId, table.url),
  ]
);

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    key: text("key"),
    content: text("content").notNull(),
    tags: text("tags"),
    source: text("source"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
    ownerId: text("owner_id"),
  },
  (table) => [
    index("idx_memories_updated_at").on(table.updatedAt),
    index("idx_memories_owner").on(table.ownerId),
    unique("memories_owner_key_unq").on(table.ownerId, table.key),
  ]
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
    id: text("id").primaryKey(),
    prefix: text("prefix").notNull(),
    publicId: text("public_id").unique(),
    currentVersionId: text("current_version_id").notNull(),
    previousVersionId: text("previous_version_id"),
    machineId: text("machine_id").notNull(),
    hash: text("hash").notNull(),
    fileCount: integer("file_count").notNull().default(0),
    totalSize: integer("total_size").notNull().default(0),
    pushedAt: text("pushed_at").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
    ownerId: text("owner_id"),
  },
  (table) => [
    index("idx_bundle_versions_current").on(table.currentVersionId),
    index("idx_bundle_versions_pushed_at").on(table.pushedAt),
    index("idx_bundle_versions_owner").on(table.ownerId),
    unique("bundle_versions_owner_prefix_unq").on(table.ownerId, table.prefix),
  ]
);

export const userAccess = sqliteTable(
  "user_access",
  {
    userId: text("user_id").primaryKey(),
    status: text("status").notNull().default("pending"),
    message: text("message"),
    referredBy: text("referred_by"),
    appliedAt: text("applied_at"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
  },
  (table) => [index("idx_user_access_status").on(table.status)]
);

export const allowlist = sqliteTable("allowlist", {
  email: text("email").primaryKey(),
  addedBy: text("added_by"),
  addedAt: text("added_at"),
});

export const registrationIntents = sqliteTable(
  "registration_intents",
  {
    token: text("token").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    ref: text("ref"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
  },
  (table) => [index("idx_registration_intents_email").on(table.email)]
);

/**
 * Shared Spaces P1 (design: docs/implementation/2026-07-19-shared-spaces-design.md).
 *
 * A Space is a sharing/authorization layer on top of #30's per-owner isolation: it lets
 * users reference each other's existing files/folders/memory **by reference** (no storage
 * duplication — the bytes/rows stay owned by whoever contributed them). `visibility` is
 * `'invite'` (creator-managed membership) in P1; `'public'` (the single built-in commons,
 * implicit membership for all active users) is P2.
 */
export const spaces = sqliteTable("spaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  creatorId: text("creator_id").notNull(),
  visibility: text("visibility").notNull().default("invite"), // 'invite' | 'public'
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

/**
 * Explicit membership rows for a space. The creator is NOT required to have a row here —
 * `resolveSpaceRole` derives 'creator' from `spaces.creatorId` — so this table only ever
 * holds invited members (viewer/contributor/editor). Public-space implicit membership (P2)
 * has no row per user either; an explicit row there would only be used to OVERRIDE a
 * specific user's default role.
 */
export const spaceMembers = sqliteTable(
  "space_members",
  {
    spaceId: text("space_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(), // 'viewer' | 'contributor' | 'editor'
    addedBy: text("added_by").notNull(),
    addedAt: text("added_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.userId] }),
    index("idx_space_members_user").on(table.userId),
  ]
);

/**
 * A reference-only row into a space: `itemRef` is `files.id` for a `'file'` item, the
 * folder root's `files.id` for a `'folder'` item (descendants resolved on read via
 * `expandFolderItemToFileIds`), or `memories.id` for a `'memory'` item. Removing a row here
 * removes the reference only — the underlying resource is untouched and stays owned by
 * `contributedBy`.
 */
export const spaceItems = sqliteTable(
  "space_items",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id").notNull(),
    itemType: text("item_type").notNull(), // 'file' | 'folder' | 'memory'
    itemRef: text("item_ref").notNull(),
    contributedBy: text("contributed_by").notNull(),
    addedAt: text("added_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_space_items_space").on(table.spaceId),
    unique("space_items_space_type_ref_unq").on(table.spaceId, table.itemType, table.itemRef),
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
    label: text("label"),
  },
  (table) => [
    index("idx_oauth_tokens_access").on(table.accessTokenHash),
    index("idx_oauth_tokens_refresh").on(table.refreshTokenHash),
    index("idx_oauth_tokens_client").on(table.clientId),
    index("idx_oauth_tokens_user").on(table.userId),
    index("idx_oauth_tokens_source_code").on(table.sourceCodeId),
    index("idx_oauth_tokens_created_at").on(table.createdAt),
  ]
);
