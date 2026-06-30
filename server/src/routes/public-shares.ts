import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { zipSync } from "fflate";

import { buckets, files, shares } from "@defs";

import { logEvent, logEventsBatch } from "../lib/activity";
import { createAccessToken, verifyAccessToken, verifyPasswordHash } from "../lib/crypto";
import { ApiError, withErrorHandling } from "../lib/errors";
import { escapedDescendantPattern, normalizePath } from "../lib/paths";
import { checkRateLimit, clearRateLimit, recordFailure } from "../lib/rate-limit";
import type { AppDb } from "../types";

export const publicSharesRoutes = new Hono();
const MAX_ZIP_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const ROOT_SHARE_NAME = "Drive";

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

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function storedRelativePath(fullPath: string, basePath: string): string {
  const base = normalizePath(basePath);
  if (base === "/") return fullPath.startsWith("/") ? fullPath.slice(1) : fullPath;
  if (fullPath === base) return "";
  return fullPath.startsWith(`${base}/`) ? fullPath.slice(base.length + 1) : fullPath;
}

function assertShareAccessible(share: typeof shares.$inferSelect): void {
  if (isExpired(share.expiresAt)) throw new ApiError(410, "share_expired", "Share link has expired");
  if (isExhausted(share.maxDownloads, share.downloadCount)) {
    throw new ApiError(429, "share_exhausted", "Share download limit reached");
  }
}

function requestActivityContext(c: { req: { header: (name: string) => string | undefined } }): { ip: string | null; userAgent: string | null } {
  return {
    ip: c.req.header("cf-connecting-ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
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
  const valid = await verifyAccessToken(c.req.header("x-access-token"), share.id, tokenSecret, share.passwordVersion ?? 1);
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
        ...requestActivityContext(c),
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
      const [file] = await db.select().from(files).where(and(eq(files.id, share.fileId), isNull(files.deletedAt))).limit(1);
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
        ...requestActivityContext(c),
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
    const folder = folderPath === "/"
      ? null
      : (await db.select().from(files).where(and(eq(files.path, folderPath), eq(files.isFolder, 1), isNull(files.deletedAt))).limit(1))[0];
    if (folderPath !== "/" && !folder) throw new ApiError(404, "file_not_found", "Shared folder not found");

    const descendants = await db.select({ size: files.size, isFolder: files.isFolder }).from(files).where(and(sql`${files.path} LIKE ${escapedDescendantPattern(folderPath)} ESCAPE '\\'`, isNull(files.deletedAt)));
    const size = descendants.filter((x) => x.isFolder === 0).reduce((sum, x) => sum + x.size, 0);
    const fileCount = descendants.filter((x) => x.isFolder === 0).length;

    await logEvent(db, {
      eventType: "share.accessed",
      targetType: "share",
      targetId: share.id,
      targetPath: folderPath,
      actor: "public",
      metadata: {
        shareType: "folder",
        folderPath,
        fileCount,
      },
      ...requestActivityContext(c),
    });

    return c.json({
      id: share.id,
      type: "folder",
      name: folder?.name ?? ROOT_SHARE_NAME,
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

publicSharesRoutes.post(
  "/:shareId/access",
  withErrorHandling(async (c) => {
    const shareId = getShareId(c);
    const body = (await c.req.json().catch(() => ({}))) as { password?: string };
    const { db, secret } = await import("edgespark");
    const rateLimitKey = `share-access:${shareId}`;
    const limitState = await checkRateLimit(db, rateLimitKey, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS);
    if (!limitState.allowed) {
      const retryAfterMs = limitState.retryAfterMs ?? RATE_LIMIT_WINDOW_MS;
      c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      throw new ApiError(429, "too_many_attempts", `Too many failed password attempts. Try again in ${Math.ceil(retryAfterMs / 60000)} minutes.`);
    }

    const [share] = await db.select().from(shares).where(eq(shares.id, shareId)).limit(1);
    if (!share) throw new ApiError(404, "share_not_found", "Share link not found");
    assertShareAccessible(share);

    if (share.passwordHash) {
      const valid = await verifyPasswordHash(body.password ?? "", share.passwordHash);
      if (!valid) {
        await recordFailure(db, rateLimitKey, RATE_LIMIT_WINDOW_MS);
        await logEvent(db, {
          eventType: "share.password_failed",
          targetType: "share",
          targetId: share.id,
          targetPath: share.folderPath,
          actor: "public",
          metadata: {
            fileId: share.fileId,
          },
          ...requestActivityContext(c),
        });
        throw new ApiError(403, "wrong_password", "Wrong share password");
      }
    }
    await clearRateLimit(db, rateLimitKey);

    const tokenSecret = secret.get("AGENT_TOKEN");
    if (!tokenSecret) throw new ApiError(500, "internal_error", "AGENT_TOKEN is not configured");

    const token = await createAccessToken(share.id, tokenSecret, share.passwordVersion ?? 1);
    return c.json({ accessToken: token.token, expiresAt: token.expiresAt });
  })
);

publicSharesRoutes.get(
  "/:shareId/files",
  withErrorHandling(async (c) => {
    const { share, db } = await resolveShareAndToken(c);

    if (share.fileId) {
      const [file] = await db.select().from(files).where(and(eq(files.id, share.fileId), eq(files.isFolder, 0), isNull(files.deletedAt))).limit(1);
      if (!file) throw new ApiError(404, "file_not_found", "Shared file not found");
      return c.json({ files: [{ id: file.id, name: file.name, path: file.name, isFolder: false, size: file.size, contentType: file.contentType }] });
    }

    const folderPath = normalizePath(share.folderPath ?? "/");
    const rows = await db.select().from(files).where(and(sql`${files.path} LIKE ${escapedDescendantPattern(folderPath)} ESCAPE '\\'`, isNull(files.deletedAt))).orderBy(asc(files.path));
    return c.json({
      files: rows.flatMap((row) => {
        const path = storedRelativePath(row.path, folderPath);
        if (!isSafeRelativePath(path)) return [];
        return [{
          id: row.id,
          name: row.name,
          path,
          isFolder: row.isFolder === 1,
          size: row.size,
          contentType: row.contentType,
        }];
      }),
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
      [target] = await db.select().from(files).where(and(eq(files.id, share.fileId), eq(files.isFolder, 0), isNull(files.deletedAt))).limit(1);
    } else {
      const fileId = (c.req.query("fileId") ?? "").trim();
      if (!fileId) throw new ApiError(400, "validation_error", "fileId is required for single file download. Use /download-zip to download all files.");
      const folderPath = normalizePath(share.folderPath ?? "/");
      [target] = await db
        .select()
        .from(files)
        .where(and(
          eq(files.id, fileId),
          eq(files.isFolder, 0),
          isNull(files.deletedAt),
          or(eq(files.path, folderPath), sql`${files.path} LIKE ${escapedDescendantPattern(folderPath)} ESCAPE '\\'`)
        ))
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
      ...requestActivityContext(c),
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
    if (subPath && !isSafeRelativePath(subPath)) {
      throw new ApiError(400, "validation_error", "Path must be a safe relative path inside the shared folder");
    }
    basePath = subPath ? normalizePath(`${folderPath}/${subPath}`) : folderPath;

    if (!basePath.startsWith(folderPath)) {
      throw new ApiError(400, "validation_error", "Path is outside the shared folder");
    }

    if (basePath === "/") {
      zipName = sanitizeZipFilename(ROOT_SHARE_NAME);
    } else {
      const [baseFolder] = await db.select().from(files).where(and(eq(files.path, basePath), eq(files.isFolder, 1), isNull(files.deletedAt))).limit(1);
      if (!baseFolder) throw new ApiError(404, "file_not_found", "Folder not found in share");
      zipName = sanitizeZipFilename(baseFolder.name);
    }

    const fileRows = await db
      .select()
      .from(files)
      .where(and(sql`${files.path} LIKE ${escapedDescendantPattern(basePath)} ESCAPE '\\'`, eq(files.isFolder, 0), isNull(files.deletedAt)))
      .orderBy(asc(files.path));

    if (fileRows.length === 0) throw new ApiError(404, "file_not_found", "No files in this folder");
    const downloadableRows = fileRows.flatMap((row) => {
      const entryPath = storedRelativePath(row.path, basePath);
      return isSafeRelativePath(entryPath) ? [{ row, entryPath }] : [];
    });

    const totalSize = downloadableRows.reduce((sum, item) => sum + item.row.size, 0);
    if (totalSize > MAX_ZIP_DOWNLOAD_BYTES) {
      return c.json({
        error: {
          code: "zip_too_large",
          message: `ZIP download is limited to 30MB. This folder is ${Math.ceil(totalSize / (1024 * 1024))}MB.`,
          hint: "Use GET /files to list all files, then GET /download?fileId=<id> to download each file individually. Preserve the relative path from the file list to maintain folder structure.",
          filesEndpoint: `/api/public/s/${getShareId(c)}/files`,
          fileCount: downloadableRows.length,
          totalSizeMB: Math.ceil(totalSize / (1024 * 1024)),
        },
      }, 413);
    }

    const zipEntries: Record<string, Uint8Array> = {};
    for (const { row, entryPath } of downloadableRows) {
      if (!row.s3Uri) continue;
      const parsed = storage.tryParseS3Uri(row.s3Uri);
      if (!parsed) continue;
      const obj = await storage.from(buckets.drive).get(parsed.path);
      if (!obj) continue;
      const buffer = obj.body;
      zipEntries[entryPath] = new Uint8Array(buffer);
    }

    if (Object.keys(zipEntries).length === 0) {
      throw new ApiError(404, "file_not_found", "No downloadable files found");
    }

    const zipped = zipSync(zipEntries);
    await incrementDownloadCountOrThrow(db, share.id);
    const activityContext = requestActivityContext(c);
    await logEventsBatch(db, downloadableRows.map(({ row }) => ({
      eventType: "share.downloaded",
      targetType: "share",
      targetId: share.id,
      targetPath: row.path,
      actor: "public",
      metadata: {
        fileId: row.id,
        filename: row.name,
        mode: "zip",
        zipName,
      },
      ...activityContext,
    })), {
      eventType: "share.downloaded",
      data: {
        targetType: "share",
        targetId: share.id,
        targetPath: basePath,
        actor: "public",
        metadata: {
          mode: "zip",
          zipName,
          fileIds: downloadableRows.map(({ row }) => row.id),
          totalSize,
          count: downloadableRows.length,
        },
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
