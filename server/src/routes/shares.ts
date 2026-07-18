import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { activityLog, files, shares } from "@defs";

import { getRequestActor, logEvent } from "../lib/activity";
import { currentOwnerId } from "../lib/request-owner";
import { hashPassword } from "../lib/crypto";
import { nowIso } from "../lib/files";
import { ApiError, withErrorHandling } from "../lib/errors";
import { normalizePath } from "../lib/paths";
import { parseListPagination } from "../lib/pagination";
import { assertRestPathAllowed, restPathFilter } from "../lib/rest-scopes";
import type { AppDb, AppEnv, ShareObject, ShareRow } from "../types";

export const sharesRoutes = new Hono<AppEnv>();
const ROOT_SHARE_NAME = "Drive";

function getShareId(c: { req: { param: (name: string) => string | undefined } }): string {
  const id = c.req.param("id");
  if (!id) throw new ApiError(400, "validation_error", "Missing path param: id");
  return id;
}

async function shareTargetPath(db: AppDb, share: ShareRow): Promise<string> {
  if (share.fileId) {
    const [file] = await db.select({ path: files.path }).from(files).where(eq(files.id, share.fileId)).limit(1);
    return file?.path ?? "/";
  }
  return normalizePath(share.folderPath ?? "/");
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
  if (folderPath === "/") {
    return {
      id: share.id,
      fileId: share.fileId,
      folderPath: share.folderPath,
      type: "folder",
      targetName: ROOT_SHARE_NAME,
      hasPassword: Boolean(share.passwordHash),
      maxDownloads: share.maxDownloads,
      downloadCount: share.downloadCount,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
      shareUrl: `${origin}/s/${share.id}`,
    };
  }

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

function toShareObjectWithTarget(share: ShareRow, origin: string, targetName: string): ShareObject {
  return {
    id: share.id,
    fileId: share.fileId,
    folderPath: share.folderPath,
    type: share.fileId ? "file" : "folder",
    targetName,
    hasPassword: Boolean(share.passwordHash),
    maxDownloads: share.maxDownloads,
    downloadCount: share.downloadCount,
    expiresAt: share.expiresAt,
    createdAt: share.createdAt,
    shareUrl: `${origin}/s/${share.id}`,
  };
}

async function toShareObjects(db: AppDb, shareRows: ShareRow[], origin: string): Promise<ShareObject[]> {
  const fileIds = shareRows.map((share) => share.fileId).filter((id): id is string => Boolean(id));
  const folderPaths = shareRows
    .filter((share) => !share.fileId)
    .map((share) => normalizePath(share.folderPath ?? "/"));

  const [fileRows, folderRows] = await Promise.all([
    fileIds.length > 0 ? db.select({ id: files.id, name: files.name }).from(files).where(inArray(files.id, fileIds)) : [],
    folderPaths.length > 0 ? db.select({ path: files.path, name: files.name }).from(files).where(inArray(files.path, folderPaths)) : [],
  ]);
  const fileNameById = new Map(fileRows.map((file) => [file.id, file.name]));
  const folderNameByPath = new Map(folderRows.map((folder) => [folder.path, folder.name]));

  return shareRows.map((share) => {
    if (share.fileId) return toShareObjectWithTarget(share, origin, fileNameById.get(share.fileId) ?? "(deleted file)");
    const folderPath = normalizePath(share.folderPath ?? "/");
    if (folderPath === "/") return toShareObjectWithTarget(share, origin, ROOT_SHARE_NAME);
    return toShareObjectWithTarget(share, origin, folderNameByPath.get(folderPath) ?? folderPath.split("/").filter(Boolean).pop() ?? "/");
  });
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
    const rawFolderPath = typeof body.folderPath === "string" ? body.folderPath.trim() : undefined;
    if (body.folderPath !== undefined && !rawFolderPath) {
      throw new ApiError(400, "validation_error", "folderPath cannot be empty");
    }
    const folderPath = rawFolderPath ? normalizePath(rawFolderPath) : null;
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
      const [file] = await db.select().from(files).where(and(eq(files.id, fileId), eq(files.isFolder, 0), isNull(files.deletedAt))).limit(1);
      if (!file) throw new ApiError(404, "file_not_found", "File not found");
      assertRestPathAllowed(c, file.path);
    }
    if (folderPath) {
      assertRestPathAllowed(c, folderPath);
      if (folderPath !== "/") {
        const [folder] = await db.select().from(files).where(and(eq(files.path, folderPath), eq(files.isFolder, 1), isNull(files.deletedAt))).limit(1);
        if (!folder) throw new ApiError(404, "file_not_found", "Folder not found");
      }
    }

    const [created] = await db
      .insert(shares)
      .values({
        id: nanoid(8),
        fileId,
        folderPath,
        passwordHash: password ? await hashPassword(password) : null,
        passwordVersion: 1,
        maxDownloads: body.maxDownloads ?? null,
        downloadCount: 0,
        expiresAt: body.expiresIn ? new Date(Date.now() + body.expiresIn * 1000).toISOString() : null,
        createdAt: nowIso(),
        ownerId: currentOwnerId(),
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
    const { limit, offset } = parseListPagination((name) => c.req.query(name), { defaultLimit: 100, maxLimit: 500 });
    const nowIsoString = new Date().toISOString();
    const activeRows = await db
      .select()
      .from(shares)
      .where(and(
        or(isNull(shares.expiresAt), gt(shares.expiresAt, nowIsoString)),
        or(isNull(shares.maxDownloads), sql`${shares.downloadCount} < ${shares.maxDownloads}`)
      ))
      .orderBy(desc(shares.createdAt))
      .limit(limit)
      .offset(offset);
    const origin = new URL(c.req.url).origin;

    const pathVisible = restPathFilter(c);
    const shareFileIds = activeRows.map((row) => row.fileId).filter((id): id is string => Boolean(id));
    const filePathRows = shareFileIds.length > 0
      ? await db.select({ id: files.id, path: files.path }).from(files).where(inArray(files.id, shareFileIds))
      : [];
    const filePathById = new Map(filePathRows.map((row) => [row.id, row.path]));
    const visibleRows = activeRows.filter((row) =>
      pathVisible(row.fileId ? filePathById.get(row.fileId) ?? "/" : normalizePath(row.folderPath ?? "/"))
    );
    return c.json({ shares: await toShareObjects(db, visibleRows, origin), limit, offset });
  })
);

sharesRoutes.get(
  "/shares/:id",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const share = await getShareById(db, getShareId(c));
    assertRestPathAllowed(c, await shareTargetPath(db, share));
    return c.json({ share: await toShareObject(db, share, new URL(c.req.url).origin) });
  })
);

sharesRoutes.get(
  "/shares/:id/stats",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const share = await getShareById(db, getShareId(c));
    assertRestPathAllowed(c, await shareTargetPath(db, share));
    const shareObject = await toShareObject(db, share, new URL(c.req.url).origin);
    const [summary] = await db
      .select({
        totalDownloads: sql<number>`sum(case when ${activityLog.eventType} = 'share.downloaded' then 1 else 0 end)`,
        totalAccesses: sql<number>`sum(case when ${activityLog.eventType} = 'share.accessed' then 1 else 0 end)`,
        firstAccessed: sql<string | null>`min(case when ${activityLog.eventType} = 'share.accessed' then ${activityLog.createdAt} else null end)`,
        lastAccessed: sql<string | null>`max(case when ${activityLog.eventType} = 'share.accessed' then ${activityLog.createdAt} else null end)`,
        lastDownload: sql<string | null>`max(case when ${activityLog.eventType} = 'share.downloaded' then ${activityLog.createdAt} else null end)`,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.targetId, share.id),
          sql`${activityLog.eventType} in ('share.downloaded', 'share.accessed')`
        )
      );
    const fileBreakdownRows = await db
      .select({
        fileId: sql<string>`json_extract(${activityLog.metadata}, '$.fileId')`,
        filename: sql<string>`coalesce(json_extract(${activityLog.metadata}, '$.filename'), json_extract(${activityLog.metadata}, '$.fileId'))`,
        downloads: sql<number>`count(*)`,
      })
      .from(activityLog)
      .where(and(eq(activityLog.targetId, share.id), eq(activityLog.eventType, "share.downloaded"), sql`json_extract(${activityLog.metadata}, '$.fileId') is not null`))
      .groupBy(sql`json_extract(${activityLog.metadata}, '$.fileId')`, sql`coalesce(json_extract(${activityLog.metadata}, '$.filename'), json_extract(${activityLog.metadata}, '$.fileId'))`)
      .orderBy(desc(sql<number>`count(*)`), asc(sql<string>`coalesce(json_extract(${activityLog.metadata}, '$.filename'), json_extract(${activityLog.metadata}, '$.fileId'))`));
    const ipStats = await db
      .select({ ip: activityLog.ip, count: sql<number>`count(*)` })
      .from(activityLog)
      .where(and(eq(activityLog.targetId, share.id), sql`${activityLog.eventType} in ('share.downloaded', 'share.accessed')`, sql`${activityLog.ip} is not null`))
      .groupBy(activityLog.ip)
      .orderBy(desc(sql<number>`count(*)`))
      .limit(5);
    const userAgentStats = await db
      .select({ userAgent: activityLog.userAgent, count: sql<number>`count(*)` })
      .from(activityLog)
      .where(and(eq(activityLog.targetId, share.id), sql`${activityLog.eventType} in ('share.downloaded', 'share.accessed')`, sql`${activityLog.userAgent} is not null`))
      .groupBy(activityLog.userAgent)
      .orderBy(desc(sql<number>`count(*)`))
      .limit(5);

    return c.json({
      share: shareObject,
      totalDownloads: Number(summary?.totalDownloads ?? 0),
      totalAccesses: Number(summary?.totalAccesses ?? 0),
      firstAccessed: summary?.firstAccessed ?? null,
      lastAccessed: summary?.lastAccessed ?? null,
      lastDownload: summary?.lastDownload ?? null,
      fileBreakdown: fileBreakdownRows.map((row) => ({ fileId: row.fileId, filename: row.filename, downloads: Number(row.downloads) })),
      ipStats: ipStats.map((row) => ({ ip: row.ip, count: Number(row.count) })),
      userAgentStats: userAgentStats.map((row) => ({ userAgent: row.userAgent, count: Number(row.count) })),
    });
  })
);

sharesRoutes.delete(
  "/shares/:id",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const share = await getShareById(db, getShareId(c));
    assertRestPathAllowed(c, await shareTargetPath(db, share));
    const deleted = await db.delete(shares).where(eq(shares.id, share.id)).returning();
    const deletedShare = deleted[0];
    if (!deletedShare) throw new ApiError(404, "share_not_found", "Share link not found");
    await logEvent(db, {
      eventType: "share.deleted",
      targetType: "share",
      targetId: deletedShare.id,
      targetPath: deletedShare.folderPath,
      actor: await getRequestActor(),
      metadata: {
        fileId: deletedShare.fileId,
        folderPath: deletedShare.folderPath,
      },
    });
    return c.json({ success: true });
  })
);

sharesRoutes.get(
  "/stats",
  withErrorHandling(async (c) => {
    // Stats aggregate the whole drive; require an unrestricted token.
    assertRestPathAllowed(c, "/");
    const { db } = await import("edgespark");
    const [filesCount, foldersCount, sizeSum, shareCount, downloadSum] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(files).where(and(eq(files.isFolder, 0), isNull(files.deletedAt))),
      db.select({ count: sql<number>`count(*)` }).from(files).where(and(eq(files.isFolder, 1), isNull(files.deletedAt))),
      db.select({ total: sql<number>`coalesce(sum(${files.size}), 0)` }).from(files).where(and(eq(files.isFolder, 0), isNull(files.deletedAt))),
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
