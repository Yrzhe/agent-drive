import { and, eq } from "drizzle-orm";

import { files, shares } from "@defs";

import type { AppDb, ShareRow } from "../types";
import { ApiError } from "./errors";
import { normalizePath } from "./paths";

export function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) && ms <= Date.now();
}

export function isExhausted(maxDownloads: number | null, downloadCount: number): boolean {
  return maxDownloads !== null && downloadCount >= maxDownloads;
}

export async function getShareById(db: AppDb, id: string): Promise<ShareRow> {
  const [share] = await db.select().from(shares).where(eq(shares.id, id)).limit(1);
  if (!share) {
    throw new ApiError(404, "share_not_found", "Share link not found");
  }
  return share;
}

export async function assertShareIsAccessible(share: ShareRow): Promise<void> {
  if (isExpired(share.expiresAt)) {
    throw new ApiError(410, "share_expired", "Share link has expired");
  }
  if (isExhausted(share.maxDownloads, share.downloadCount)) {
    throw new ApiError(429, "share_exhausted", "Share download limit reached");
  }
}

export async function buildShareObject(db: AppDb, share: ShareRow, origin: string) {
  let type: "file" | "folder";
  let targetName = "";

  if (share.fileId) {
    type = "file";
    const [file] = await db.select().from(files).where(eq(files.id, share.fileId)).limit(1);
    targetName = file?.name ?? "(deleted file)";
  } else {
    type = "folder";
    const folderPath = normalizePath(share.folderPath ?? "/");
    const [folder] = await db
      .select()
      .from(files)
      .where(and(eq(files.path, folderPath), eq(files.isFolder, 1)))
      .limit(1);
    targetName = folder?.name ?? folderPath.split("/").filter(Boolean).pop() ?? "/";
  }

  return {
    id: share.id,
    fileId: share.fileId,
    folderPath: share.folderPath,
    type,
    targetName,
    hasPassword: Boolean(share.passwordHash),
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount,
    expiresAt: share.expiresAt,
    createdAt: share.createdAt,
    shareUrl: `${origin}/s/${share.id}`,
  };
}
