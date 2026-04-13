import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { files, shares } from "@defs";

import { getRequestActor, logEvent } from "../lib/activity";
import { sha256Hex } from "../lib/crypto";
import { nowIso } from "../lib/files";
import { ApiError, withErrorHandling } from "../lib/errors";
import { normalizePath } from "../lib/paths";
import type { AppDb, ShareObject, ShareRow } from "../types";

export const sharesRoutes = new Hono();

function getShareId(c: { req: { param: (name: string) => string | undefined } }): string {
  const id = c.req.param("id");
  if (!id) throw new ApiError(400, "validation_error", "Missing path param: id");
  return id;
}

async function getShareById(db: AppDb, id: string): Promise<ShareRow> {
  const [share] = await db.select().from(shares).where(eq(shares.id, id)).limit(1);
  if (!share) throw new ApiError(404, "share_not_found", "Share link not found");
  return share;
}

async function toShareObject(db: AppDb, share: ShareRow, origin: string): Promise<ShareObject> {
  if (share.fileId) {
    const [file] = await db.select().from(files).where(eq(files.id, share.fileId)).limit(1);
    return {
      id: share.id,
      fileId: share.fileId,
      folderPath: share.folderPath,
      type: "file",
      targetName: file?.name ?? "(deleted file)",
      hasPassword: Boolean(share.passwordHash),
      maxDownloads: share.maxDownloads,
      downloadCount: share.downloadCount,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
      shareUrl: `${origin}/s/${share.id}`,
    };
  }

  const folderPath = normalizePath(share.folderPath ?? "/");
  const [folder] = await db
    .select()
    .from(files)
    .where(and(eq(files.path, folderPath), eq(files.isFolder, 1)))
    .limit(1);
  const targetName = folder?.name ?? folderPath.split("/").filter(Boolean).pop() ?? "/";

  return {
    id: share.id,
    fileId: share.fileId,
    folderPath: share.folderPath,
    type: "folder",
    targetName,
    hasPassword: Boolean(share.passwordHash),
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount,
    expiresAt: share.expiresAt,
    createdAt: share.createdAt,
    shareUrl: `${origin}/s/${share.id}`,
  };
}

sharesRoutes.post(
  "/shares",
  withErrorHandling(async (c) => {
    const body = (await c.req.json()) as {
      fileId?: string;
      folderPath?: string;
      password?: string;
      maxDownloads?: number;
      expiresIn?: number;
    };

    const fileId = body.fileId?.trim() || null;
    const folderPath = body.folderPath ? normalizePath(body.folderPath) : null;
    if ((fileId ? 1 : 0) + (folderPath ? 1 : 0) !== 1) {
      throw new ApiError(400, "validation_error", "Exactly one of fileId or folderPath is required");
    }
    if (body.maxDownloads != null && (!Number.isInteger(body.maxDownloads) || body.maxDownloads <= 0)) {
      throw new ApiError(400, "validation_error", "maxDownloads must be a positive integer");
    }
    if (body.expiresIn != null && (!Number.isInteger(body.expiresIn) || body.expiresIn <= 0)) {
      throw new ApiError(400, "validation_error", "expiresIn must be a positive integer in seconds");
    }

    const password = body.password?.trim();
    if (body.password !== undefined && !password) throw new ApiError(400, "validation_error", "password cannot be empty");

    const { db } = await import("edgespark");
    if (fileId) {
      const [file] = await db.select().from(files).where(and(eq(files.id, fileId), eq(files.isFolder, 0))).limit(1);
      if (!file) throw new ApiError(404, "file_not_found", "File not found");
    }
    if (folderPath) {
      const [folder] = await db.select().from(files).where(and(eq(files.path, folderPath), eq(files.isFolder, 1))).limit(1);
      if (!folder) throw new ApiError(404, "file_not_found", "Folder not found");
    }

    const [created] = await db
      .insert(shares)
      .values({
        id: nanoid(8),
        fileId,
        folderPath,
        passwordHash: password ? await sha256Hex(password) : null,
        maxDownloads: body.maxDownloads ?? null,
        downloadCount: 0,
        expiresAt: body.expiresIn ? new Date(Date.now() + body.expiresIn * 1000).toISOString() : null,
        createdAt: nowIso(),
      })
      .returning();

    await logEvent(db, {
      eventType: "share.created",
      targetType: "share",
      targetId: created.id,
      targetPath: created.folderPath,
      actor: await getRequestActor(),
      metadata: {
        fileId: created.fileId,
        folderPath: created.folderPath,
        hasPassword: Boolean(created.passwordHash),
        maxDownloads: created.maxDownloads,
        expiresAt: created.expiresAt,
      },
    });

    const origin = new URL(c.req.url).origin;
    return c.json({
      share: await toShareObject(db, created, origin),
      shareUrl: `${origin}/s/${created.id}`,
      guideUrl: `${origin}/api/public/guide`,
    });
  })
);

sharesRoutes.get(
  "/shares",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const rows = await db.select().from(shares).orderBy(desc(shares.createdAt));
    const origin = new URL(c.req.url).origin;
    const now = Date.now();
    const activeRows = rows.filter((row) => {
      if (row.expiresAt && Date.parse(row.expiresAt) <= now) return false;
      if (row.maxDownloads !== null && row.downloadCount >= row.maxDownloads) return false;
      return true;
    });
    return c.json({ shares: await Promise.all(activeRows.map((row) => toShareObject(db, row, origin))) });
  })
);

sharesRoutes.get(
  "/shares/:id",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const share = await getShareById(db, getShareId(c));
    return c.json({ share: await toShareObject(db, share, new URL(c.req.url).origin) });
  })
);

sharesRoutes.delete(
  "/shares/:id",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const deleted = await db.delete(shares).where(eq(shares.id, getShareId(c))).returning();
    if (deleted.length === 0) throw new ApiError(404, "share_not_found", "Share link not found");
    await logEvent(db, {
      eventType: "share.deleted",
      targetType: "share",
      targetId: deleted[0]!.id,
      targetPath: deleted[0]!.folderPath,
      actor: await getRequestActor(),
      metadata: {
        fileId: deleted[0]!.fileId,
        folderPath: deleted[0]!.folderPath,
      },
    });
    return c.json({ success: true });
  })
);

sharesRoutes.get(
  "/stats",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const [filesCount, foldersCount, sizeSum, shareCount, downloadSum] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(files).where(eq(files.isFolder, 0)),
      db.select({ count: sql<number>`count(*)` }).from(files).where(eq(files.isFolder, 1)),
      db.select({ total: sql<number>`coalesce(sum(${files.size}), 0)` }).from(files).where(eq(files.isFolder, 0)),
      db.select({ count: sql<number>`count(*)` }).from(shares),
      db.select({ total: sql<number>`coalesce(sum(${shares.downloadCount}), 0)` }).from(shares),
    ]);

    return c.json({
      totalFiles: Number(filesCount[0]?.count ?? 0),
      totalFolders: Number(foldersCount[0]?.count ?? 0),
      totalSize: Number(sizeSum[0]?.total ?? 0),
      totalShares: Number(shareCount[0]?.count ?? 0),
      totalDownloads: Number(downloadSum[0]?.total ?? 0),
    });
  })
);
