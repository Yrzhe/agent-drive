import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { zipSync } from "fflate";

import { buckets, files, shares } from "@defs";

import { logEvent } from "../lib/activity";
import { createAccessToken, verifyAccessToken, verifyPasswordHash } from "../lib/crypto";
import { presignPath } from "../lib/object-keys";
import { ApiError, withErrorHandling } from "../lib/errors";
import { escapedDescendantPattern, normalizePath } from "../lib/paths";
import { checkRateLimit, clearRateLimit, recordFailure } from "../lib/rate-limit";
import { SHARE_DOWNLOAD_URL_TTL_SECS, type AppDb } from "../types";

export const publicSharesRoutes = new Hono();
const MAX_ZIP_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const DEFAULT_PUBLIC_FILES_LIMIT = 200;
const MAX_PUBLIC_FILES_LIMIT = 500;
const MAX_ZIP_FILE_COUNT = 400;
const ZIP_METADATA_FILE_ID_LIMIT = 50;
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

function boundedQueryInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
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

    // Password-protected shares must not leak identifying metadata (name / size /
    // fileCount) before the password is proven — the filename alone is often
    // sensitive. Require a valid access token (obtained via POST /:id/access).
    if (share.passwordHash) {
      const { secret } = await import("edgespark");
      const tokenSecret = secret.get("AGENT_TOKEN");
      const hasValidToken = tokenSecret
        ? await verifyAccessToken(c.req.header("x-access-token"), share.id, tokenSecret, share.passwordVersion ?? 1)
        : false;
      if (!hasValidToken) {
        await logEvent(db, {
          eventType: "share.accessed",
          targetType: "share",
          targetId: share.id,
          targetPath: share.folderPath,
          actor: "public",
          metadata: { shareType, locked: true },
          ...requestActivityContext(c),
        });
        return c.json({
          id: share.id,
          type: shareType,
          hasPassword: true,
          expired,
          exhausted,
          expiresAt: share.expiresAt,
          createdAt: share.createdAt,
        });
      }
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

    const [stats] = await db
      .select({
        size: sql<number>`coalesce(sum(case when ${files.isFolder} = 0 then ${files.size} else 0 end), 0)`,
        fileCount: sql<number>`count(case when ${files.isFolder} = 0 then 1 end)`,
      })
      .from(files)
      .where(and(sql`${files.path} LIKE ${escapedDescendantPattern(folderPath)} ESCAPE '\\'`, isNull(files.deletedAt)));
    const size = Number(stats?.size ?? 0);
    const fileCount = Number(stats?.fileCount ?? 0);

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
    const limit = boundedQueryInt(c.req.query("limit"), DEFAULT_PUBLIC_FILES_LIMIT, 1, MAX_PUBLIC_FILES_LIMIT);
    const offset = boundedQueryInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

    if (share.fileId) {
      const [file] = await db.select().from(files).where(and(eq(files.id, share.fileId), eq(files.isFolder, 0), isNull(files.deletedAt))).limit(1);
      if (!file) throw new ApiError(404, "file_not_found", "Shared file not found");
      return c.json({
        files: offset === 0 ? [{ id: file.id, name: file.name, path: file.name, isFolder: false, size: file.size, contentType: file.contentType }] : [],
        limit,
        offset,
      });
    }

    const folderPath = normalizePath(share.folderPath ?? "/");
    const rows = await db
      .select()
      .from(files)
      .where(and(sql`${files.path} LIKE ${escapedDescendantPattern(folderPath)} ESCAPE '\\'`, isNull(files.deletedAt)))
      .orderBy(asc(files.path))
      .limit(limit)
      .offset(offset);
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
      limit,
      offset,
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

    const presigned = await storage.from(buckets.drive).createPresignedGetUrl(presignPath(parsed.path), SHARE_DOWNLOAD_URL_TTL_SECS);
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
      expiresInSecs: SHARE_DOWNLOAD_URL_TTL_SECS,
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

    const zipFilter = and(sql`${files.path} LIKE ${escapedDescendantPattern(basePath)} ESCAPE '\\'`, eq(files.isFolder, 0), isNull(files.deletedAt));
    const [zipStats] = await db
      .select({ fileCount: sql<number>`count(*)` })
      .from(files)
      .where(zipFilter);
    const zipFileCount = Number(zipStats?.fileCount ?? 0);

    if (zipFileCount === 0) throw new ApiError(404, "file_not_found", "No files in this folder");
    if (zipFileCount > MAX_ZIP_FILE_COUNT) {
      return c.json({
        error: {
          code: "zip_file_count_exceeded",
          message: `ZIP download is limited to ${MAX_ZIP_FILE_COUNT} files. This folder has ${zipFileCount} files.`,
          hint: "Use GET /files?limit=500&offset=0 to page through all files, then GET /download?fileId=<id> to download each file individually. Preserve the relative path from the paginated file list to maintain folder structure.",
          filesEndpoint: `/api/public/s/${getShareId(c)}/files?limit=500&offset=0`,
          fileCount: zipFileCount,
          maxFileCount: MAX_ZIP_FILE_COUNT,
        },
      }, 413);
    }

    const fileRows = await db
      .select()
      .from(files)
      .where(zipFilter)
      .orderBy(asc(files.path));

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
    const skipped: string[] = [];
    for (const { row, entryPath } of downloadableRows) {
      const parsed = row.s3Uri ? storage.tryParseS3Uri(row.s3Uri) : null;
      const obj = parsed ? await storage.from(buckets.drive).get(parsed.path) : null;
      if (!obj) {
        skipped.push(entryPath);
        continue;
      }
      zipEntries[entryPath] = new Uint8Array(obj.body);
    }

    if (Object.keys(zipEntries).length === 0) {
      throw new ApiError(404, "file_not_found", "No downloadable files found");
    }

    // A file can be missing from R2 (e.g. mid-inconsistency). Don't ship a silently
    // incomplete archive — list the skipped files so the recipient knows. Use a name
    // that can't overwrite a real entry (a file legitimately named _SKIPPED.txt).
    if (skipped.length > 0) {
      let manifestName = "_SKIPPED.txt";
      for (let n = 1; manifestName in zipEntries; n += 1) manifestName = `_SKIPPED.${n}.txt`;
      zipEntries[manifestName] = new TextEncoder().encode(
        `${skipped.length} file(s) could not be read and are MISSING from this archive:\n${skipped.join("\n")}\n`
      );
    }

    const zipped = zipSync(zipEntries);
    await incrementDownloadCountOrThrow(db, share.id);
    const activityContext = requestActivityContext(c);
    await logEvent(db, {
      eventType: "share.downloaded",
      targetType: "share",
      targetId: share.id,
      targetPath: basePath,
      actor: "public",
      metadata: {
        mode: "zip",
        zipName,
        fileIds: downloadableRows.slice(0, ZIP_METADATA_FILE_ID_LIMIT).map(({ row }) => row.id),
        totalSize,
        count: downloadableRows.length,
        skipped: skipped.length,
      },
      ...activityContext,
    });

    return new Response(zipped, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipName}"`,
        "Content-Length": String(zipped.length),
        ...(skipped.length > 0 ? { "X-Skipped-Count": String(skipped.length) } : {}),
      },
    });
  })
);
