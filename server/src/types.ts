import type { drizzleSchema, files, shares } from "@defs";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export type AppDb = DrizzleD1Database<typeof drizzleSchema>;
export type FileRow = typeof files.$inferSelect;
export type ShareRow = typeof shares.$inferSelect;

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

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const PRESIGNED_URL_TTL_SECS = 60 * 60;
