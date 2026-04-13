import { and, asc, eq, isNull, like, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { zipSync } from "fflate";

import { buckets, files, shares } from "@defs";

import { logEvent } from "../lib/activity";
import { createAccessToken, verifyAccessToken, verifyPasswordHash } from "../lib/crypto";
import { ApiError, withErrorHandling } from "../lib/errors";
import { descendantPattern, normalizePath, relativePath } from "../lib/paths";
import type { AppDb } from "../types";

export const publicSharesRoutes = new Hono();
const MAX_ZIP_DOWNLOAD_BYTES = 50 * 1024 * 1024;

function getShareId(c: { req: { param: (name: string) => string | undefined } }): string {
  const shareId = c.req.param("shareId");
  if (!shareId) throw new ApiError(400, "validation_error", "Missing path param: shareId");
  return shareId;
}

function isExpired(expiresAt: string | null): boolean {
  return expiresAt ? Date.parse(expiresAt) <= Date.now() : false;
}

function isExhausted(maxDownloads: number | null, downloadCount: number): boolean {
  return maxDownloads !== null && downloadCount >= maxDownloads;
}

function sanitizeZipFilename(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, "");
  const safe = ascii.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^[_\.-]+|[_\.-]+$/g, "");
  const base = safe || "download";
  return `${base}.zip`;
}

function assertShareAccessible(share: typeof shares.$inferSelect): void {
  if (isExpired(share.expiresAt)) throw new ApiError(410, "share_expired", "Share link has expired");
  if (isExhausted(share.maxDownloads, share.downloadCount)) {
    throw new ApiError(429, "share_exhausted", "Share download limit reached");
  }
}

async function incrementDownloadCountOrThrow(db: AppDb, shareId: string): Promise<void> {
  const updated = await db
    .update(shares)
    .set({ downloadCount: sql`${shares.downloadCount} + 1` })
    .where(and(eq(shares.id, shareId), or(isNull(shares.maxDownloads), lt(shares.downloadCount, shares.maxDownloads))))
    .returning({ id: shares.id });

  if (updated.length === 0) {
    throw new ApiError(429, "share_exhausted", "Share download limit reached");
  }
}

async function resolveShareAndToken(
  c: { req: { param: (name: string) => string | undefined; header: (name: string) => string | undefined } },
) {
  const { db, secret } = await import("edgespark");
  const [share] = await db.select().from(shares).where(eq(shares.id, getShareId(c))).limit(1);
  if (!share) throw new ApiError(404, "share_not_found", "Share link not found");
  assertShareAccessible(share);

  const tokenSecret = secret.get("AGENT_TOKEN");
  if (!tokenSecret) throw new ApiError(500, "internal_error", "AGENT_TOKEN is not configured");
  const valid = await verifyAccessToken(c.req.header("x-access-token"), share.id, tokenSecret);
  if (!valid) throw new ApiError(401, "invalid_access_token", "Invalid access token");

  return { share, db, tokenSecret };
}

publicSharesRoutes.get(
  "/:shareId",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const [share] = await db.select().from(shares).where(eq(shares.id, getShareId(c))).limit(1);
    if (!share) throw new ApiError(404, "share_not_found", "Share link not found");
    const expired = isExpired(share.expiresAt);
    const exhausted = isExhausted(share.maxDownloads, share.downloadCount);
    const shareType = share.fileId ? "file" : "folder";

    if (expired || exhausted) {
      await logEvent(db, {
        eventType: "share.accessed",
        targetType: "share",
        targetId: share.id,
        targetPath: share.folderPath,
        actor: "public",
        metadata: {
          shareType,
          expired,
          exhausted,
        },
      });
      return c.json({
        id: share.id,
        type: shareType,
        expired,
        exhausted,
        expiresAt: share.expiresAt,
        createdAt: share.createdAt,
      });
    }

    if (share.fileId) {
      const [file] = await db.select().from(files).where(eq(files.id, share.fileId)).limit(1);
      if (!file) throw new ApiError(404, "file_not_found", "Shared file not found");
      await logEvent(db, {
        eventType: "share.accessed",
        targetType: "share",
        targetId: share.id,
        targetPath: file.path,
        actor: "public",
        metadata: {
          shareType: "file",
          fileId: file.id,
        },
      });
      return c.json({
        id: share.id,
        type: "file",
        name: file.name,
        size: file.size,
        fileCount: 1,
        hasPassword: Boolean(share.passwordHash),
        maxDownloads: share.maxDownloads,
        downloadCount: share.downloadCount,
        expiresAt: share.expiresAt,
        expired,
        exhausted,
        createdAt: share.createdAt,
      });
    }

    const folderPath = normalizePath(share.folderPath ?? "/");
    const [folder] = await db.select().from(files).where(and(eq(files.path, folderPath), eq(files.isFolder, 1))).limit(1);
    if (!folder) throw new ApiError(404, "file_not_found", "Shared folder not found");

    const descendants = await db.select({ size: files.size, isFolder: files.isFolder }).from(files).where(like(files.path, descendantPattern(folderPath)));
    const size = descendants.filter((x) => x.isFolder === 0).reduce((sum, x) => sum + x.size, 0);
    const fileCount = descendants.filter((x) => x.isFolder === 0).length;

    await logEvent(db, {
      eventType: "share.accessed",
      targetType: "share",
      targetId: share.id,
      targetPath: folder.path,
      actor: "public",
      metadata: {
        shareType: "folder",
        folderPath,
        fileCount,
      },
    });

    return c.json({
      id: share.id,
      type: "folder",
      name: folder.name,
      size,
      fileCount,
      hasPassword: Boolean(share.passwordHash),
      maxDownloads: share.maxDownloads,
      downloadCount: share.downloadCount,
      expiresAt: share.expiresAt,
      expired,
      exhausted,
      createdAt: share.createdAt,
    });
  })
);

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const failedAttempts = new Map<string, { count: number; firstAt: number }>();

function checkRateLimit(shareId: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(shareId);
  if (entry && now - entry.firstAt < RATE_LIMIT_WINDOW_MS && entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((entry.firstAt + RATE_LIMIT_WINDOW_MS - now) / 1000);
    throw new ApiError(429, "too_many_attempts", `Too many failed password attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`);
  }
  if (entry && now - entry.firstAt >= RATE_LIMIT_WINDOW_MS) {
    failedAttempts.delete(shareId);
  }
}

function recordFailedAttempt(shareId: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(shareId);
  if (entry && now - entry.firstAt < RATE_LIMIT_WINDOW_MS) {
    entry.count += 1;
  } else {
    failedAttempts.set(shareId, { count: 1, firstAt: now });
  }
}

publicSharesRoutes.post(
  "/:shareId/access",
  withErrorHandling(async (c) => {
    const shareId = getShareId(c);
    checkRateLimit(shareId);

    const body = (await c.req.json().catch(() => ({}))) as { password?: string };
    const { db, secret } = await import("edgespark");

    const [share] = await db.select().from(shares).where(eq(shares.id, shareId)).limit(1);
    if (!share) throw new ApiError(404, "share_not_found", "Share link not found");
    assertShareAccessible(share);

    if (share.passwordHash) {
      const valid = await verifyPasswordHash(body.password ?? "", share.passwordHash);
      if (!valid) {
        recordFailedAttempt(shareId);
        await logEvent(db, {
          eventType: "share.password_failed",
          targetType: "share",
          targetId: share.id,
          targetPath: share.folderPath,
          actor: "public",
          metadata: {
            fileId: share.fileId,
          },
        });
        throw new ApiError(403, "wrong_password", "Wrong share password");
      }
    }
    failedAttempts.delete(shareId);

    const tokenSecret = secret.get("AGENT_TOKEN");
    if (!tokenSecret) throw new ApiError(500, "internal_error", "AGENT_TOKEN is not configured");

    const token = await createAccessToken(share.id, tokenSecret);
    return c.json({ accessToken: token.token, expiresAt: token.expiresAt });
  })
);

publicSharesRoutes.get(
  "/:shareId/files",
  withErrorHandling(async (c) => {
    const { share, db } = await resolveShareAndToken(c);

    if (share.fileId) {
      const [file] = await db.select().from(files).where(and(eq(files.id, share.fileId), eq(files.isFolder, 0))).limit(1);
      if (!file) throw new ApiError(404, "file_not_found", "Shared file not found");
      return c.json({ files: [{ id: file.id, name: file.name, path: file.name, isFolder: false, size: file.size, contentType: file.contentType }] });
    }

    const folderPath = normalizePath(share.folderPath ?? "/");
    const rows = await db.select().from(files).where(like(files.path, descendantPattern(folderPath))).orderBy(asc(files.path));
    return c.json({
      files: rows.map((row) => ({
        id: row.id,
        name: row.name,
        path: relativePath(row.path, folderPath),
        isFolder: row.isFolder === 1,
        size: row.size,
        contentType: row.contentType,
      })),
    });
  })
);

publicSharesRoutes.get(
  "/:shareId/download",
  withErrorHandling(async (c) => {
    const { share, db } = await resolveShareAndToken(c);
    const { storage } = await import("edgespark");

    let target = undefined as typeof files.$inferSelect | undefined;
    if (share.fileId) {
      [target] = await db.select().from(files).where(and(eq(files.id, share.fileId), eq(files.isFolder, 0))).limit(1);
    } else {
      const fileId = (c.req.query("fileId") ?? "").trim();
      if (!fileId) throw new ApiError(400, "validation_error", "fileId is required for single file download. Use /download-zip to download all files.");
      const folderPath = normalizePath(share.folderPath ?? "/");
      [target] = await db
        .select()
        .from(files)
        .where(and(eq(files.id, fileId), eq(files.isFolder, 0), or(eq(files.path, folderPath), like(files.path, descendantPattern(folderPath)))))
        .limit(1);
    }

    if (!target) throw new ApiError(404, "file_not_found", "Shared file not found");
    if (!target.s3Uri) throw new ApiError(404, "upload_not_found", "Storage path not found");

    const parsed = storage.tryParseS3Uri(target.s3Uri);
    if (!parsed) throw new ApiError(404, "upload_not_found", "Storage path is invalid");

    const presigned = await storage.from(buckets.drive).createPresignedGetUrl(parsed.path, 60 * 60);
    await incrementDownloadCountOrThrow(db, share.id);
    await logEvent(db, {
      eventType: "share.downloaded",
      targetType: "share",
      targetId: share.id,
      targetPath: target.path,
      actor: "public",
      metadata: {
        fileId: target.id,
        filename: target.name,
        mode: "single",
      },
    });

    return c.json({
      downloadUrl: presigned.downloadUrl,
      filename: target.name,
      size: target.size,
      expiresAt: presigned.expiresAt.toISOString(),
    });
  })
);

publicSharesRoutes.get(
  "/:shareId/download-zip",
  withErrorHandling(async (c) => {
    const { share, db } = await resolveShareAndToken(c);
    const { storage } = await import("edgespark");

    const subPath = (c.req.query("path") ?? "").trim();
    let basePath: string;
    let zipName: string;

    if (share.fileId) {
      throw new ApiError(400, "validation_error", "ZIP download is only for folder shares. Use /download for single files.");
    }

    const folderPath = normalizePath(share.folderPath ?? "/");
    basePath = subPath ? normalizePath(`${folderPath}/${subPath}`) : folderPath;

    if (!basePath.startsWith(folderPath)) {
      throw new ApiError(400, "validation_error", "Path is outside the shared folder");
    }

    const [baseFolder] = await db.select().from(files).where(and(eq(files.path, basePath), eq(files.isFolder, 1))).limit(1);
    if (!baseFolder) throw new ApiError(404, "file_not_found", "Folder not found in share");
    zipName = sanitizeZipFilename(baseFolder.name);

    const fileRows = await db
      .select()
      .from(files)
      .where(and(like(files.path, descendantPattern(basePath)), eq(files.isFolder, 0)))
      .orderBy(asc(files.path));

    if (fileRows.length === 0) throw new ApiError(404, "file_not_found", "No files in this folder");
    const totalSize = fileRows.reduce((sum, row) => sum + row.size, 0);
    if (totalSize > MAX_ZIP_DOWNLOAD_BYTES) {
      return c.json({
        error: {
          code: "zip_too_large",
          message: `ZIP download is limited to 50MB. This folder is ${Math.ceil(totalSize / (1024 * 1024))}MB.`,
          hint: "Use GET /files to list all files, then GET /download?fileId=<id> to download each file individually. Preserve the relative path from the file list to maintain folder structure.",
          filesEndpoint: `/api/public/s/${getShareId(c)}/files`,
          fileCount: fileRows.length,
          totalSizeMB: Math.ceil(totalSize / (1024 * 1024)),
        },
      }, 413);
    }

    const zipEntries: Record<string, Uint8Array> = {};
    for (const row of fileRows) {
      if (!row.s3Uri) continue;
      const parsed = storage.tryParseS3Uri(row.s3Uri);
      if (!parsed) continue;
      const obj = await storage.from(buckets.drive).get(parsed.path);
      if (!obj) continue;
      const buffer = obj.body;
      const entryPath = relativePath(row.path, basePath);
      zipEntries[entryPath] = new Uint8Array(buffer);
    }

    if (Object.keys(zipEntries).length === 0) {
      throw new ApiError(404, "file_not_found", "No downloadable files found");
    }

    const zipped = zipSync(zipEntries);
    await incrementDownloadCountOrThrow(db, share.id);
    await logEvent(db, {
      eventType: "share.downloaded",
      targetType: "share",
      targetId: share.id,
      targetPath: basePath,
      actor: "public",
      metadata: {
        mode: "zip",
        fileCount: Object.keys(zipEntries).length,
        zipName,
      },
    });

    return new Response(zipped, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipName}"`,
        "Content-Length": String(zipped.length),
      },
    });
  })
);
