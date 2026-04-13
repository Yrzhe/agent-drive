import type { activityLog, drizzleSchema, files, shares, webhooks } from "@defs";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export type AppDb = DrizzleD1Database<typeof drizzleSchema>;
export type FileRow = typeof files.$inferSelect;
export type ShareRow = typeof shares.$inferSelect;
export type ActivityLogRow = typeof activityLog.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;

export type ActivityTargetType = "file" | "folder" | "share";
export type ActivityActor = "owner" | "agent" | "public";

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
}

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const PRESIGNED_URL_TTL_SECS = 60 * 60;
