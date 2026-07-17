import type { activityLog, drizzleSchema, files, shares, webhooks } from "@defs";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export type AppDb = DrizzleD1Database<typeof drizzleSchema>;
export type FileRow = typeof files.$inferSelect;
export type ShareRow = typeof shares.$inferSelect;
export type ActivityLogRow = typeof activityLog.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;

export type ActivityTargetType = "file" | "folder" | "share" | "memory" | "token";
export type ActivityActor = "owner" | "agent" | "public";

/** Resolved once by requireDualAuth and read by REST route scope helpers. */
export type RestAuth =
  | { kind: "session" }
  | { kind: "bearer"; scopes: readonly string[] };

export type AppEnv = { Variables: { restAuth?: RestAuth } };

export interface FileObject {
  id: string;
  name: string;
  path: string;
  parentPath: string;
  isFolder: boolean;
  size: number;
  contentType: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicFileObject {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  size: number;
  contentType: string | null;
}

export interface ShareObject {
  id: string;
  fileId: string | null;
  folderPath: string | null;
  type: "file" | "folder";
  targetName: string;
  hasPassword: boolean;
  maxDownloads: number | null;
  downloadCount: number;
  expiresAt: string | null;
  createdAt: string;
  shareUrl: string;
}

export interface ActivityEventInput {
  eventType: string;
  targetType?: ActivityTargetType;
  targetId?: string | null;
  targetPath?: string | null;
  actor: ActivityActor;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const PRESIGNED_URL_TTL_SECS = 60 * 60;

/**
 * Lifetime of the presigned GET URLs handed to callers. The signature is checked when the
 * request starts, so a slow transfer of a large file is fine — this only has to cover the gap
 * between issuing the URL and starting the download. Agents routinely think (or call another
 * tool) in that gap, and an expired URL surfaces as a bare 403 that reads like a block.
 *
 * Both surfaces use the same value on purpose: a share recipient and the owner previewing a
 * file are doing the same thing. Keep them equal unless there is a stated reason not to.
 *
 * Trade-off: a presigned URL is unauthenticated, and `downloadCount` increments when the URL is
 * *issued*, not when bytes are fetched — so within this window a leaked URL can be re-fetched
 * without counting against `maxDownloads`. Lengthening this widens that window. See #47.
 */
export const SHARE_DOWNLOAD_URL_TTL_SECS = 300;
export const PREVIEW_URL_TTL_SECS = 300;
