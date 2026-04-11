import { and, asc, desc, eq, inArray, like, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { buckets, files, shares } from "@defs";
import { ensureFolderChain, nowIso, parseUploadObjectPath, toFileObject } from "../lib/files";
import { ApiError, withErrorHandling } from "../lib/errors";
import { descendantPattern, joinPath, normalizeName, normalizePath, parentOfPath } from "../lib/paths";
import { PRESIGNED_URL_TTL_SECS } from "../types";

export const filesRoutes = new Hono();

function isPathUniqueConflict(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message?.toLowerCase() ?? "";
  return message.includes("unique constraint failed: files.path") || message.includes("duplicate key") && message.includes("files.path");
}

function getIdParam(c: { req: { param: (name: string) => string | undefined } }): string {
  const id = c.req.param("id");
  if (!id) throw new ApiError(400, "validation_error", "Missing path param: id");
  return id;
}

filesRoutes.post(
  "/upload",
  withErrorHandling(async (c) => {
    const body = (await c.req.json()) as { filename?: string; contentType?: string; size?: number; path?: string };
    const filename = normalizeName(body.filename);
    const contentType = (body.contentType ?? "application/octet-stream").trim();
    if (!contentType) throw new ApiError(400, "validation_error", "contentType is required");
    if (!Number.isFinite(body.size) || Number(body.size) < 0) {
      throw new ApiError(400, "validation_error", "size must be a non-negative number");
    }

    const parentPath = normalizePath(body.path ?? "/");
    const { db, storage } = await import("edgespark");
    await ensureFolderChain(db, parentPath);

    const targetPath = joinPath(parentPath, filename);
    const [conflict] = await db.select().from(files).where(eq(files.path, targetPath)).limit(1);
    if (conflict) throw new ApiError(409, "path_conflict", "Path already exists");

    const fileId = nanoid();
    const objectPath = `${fileId}/${filename}`;
    const presigned = await storage.from(buckets.drive).createPresignedPutUrl(objectPath, PRESIGNED_URL_TTL_SECS, {
      contentType,
    });

    return c.json({
      fileId,
      filename,
      path: parentPath,
      uploadUrl: presigned.uploadUrl,
      requiredHeaders: presigned.requiredHeaders,
      expiresAt: presigned.expiresAt.toISOString(),
    });
  })
);

filesRoutes.post(
  "/upload/complete",
  withErrorHandling(async (c) => {
    const body = (await c.req.json()) as { fileId?: string; filename?: string; path?: string };
    const fileId = (body.fileId ?? "").trim();
    if (!fileId) throw new ApiError(400, "validation_error", "fileId is required");

    const filename = normalizeName(body.filename);
    const parentPath = normalizePath(body.path ?? "/");

    const { db, storage } = await import("edgespark");
    const objectPath = `${fileId}/${filename}`;
    const metadata = await storage.from(buckets.drive).head(objectPath);
    if (!metadata) throw new ApiError(404, "upload_not_found", "Uploaded file not found in storage");

    await ensureFolderChain(db, parentPath);

    const targetPath = joinPath(parentPath, filename);
    const [conflict] = await db.select().from(files).where(eq(files.path, targetPath)).limit(1);
    if (conflict) throw new ApiError(409, "path_conflict", "Path already exists");

    const timestamp = nowIso();
    let inserted: typeof files.$inferSelect;
    try {
      [inserted] = await db
        .insert(files)
        .values({
          id: fileId,
          name: filename,
          path: targetPath,
          parentPath,
          isFolder: 0,
          size: metadata.size,
          contentType: metadata.contentType ?? null,
          s3Uri: storage.createS3Uri(buckets.drive, objectPath),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning();
    } catch (error) {
      if (isPathUniqueConflict(error)) {
        throw new ApiError(409, "path_conflict", "Path already exists");
      }
      throw error;
    }

    return c.json({ file: toFileObject(inserted) });
  })
);

filesRoutes.get(
  "/",
  withErrorHandling(async (c) => {
    const path = normalizePath(c.req.query("path") ?? "/");
    const recursive = c.req.query("recursive") === "true";
    const { db } = await import("edgespark");

    const result = recursive
      ? path === "/"
        ? await db.select().from(files).orderBy(asc(files.path))
        : await db.select().from(files).where(like(files.path, descendantPattern(path))).orderBy(asc(files.path))
      : await db.select().from(files).where(eq(files.parentPath, path)).orderBy(desc(files.isFolder), asc(files.name));

    return c.json({ files: result.map(toFileObject), path });
  })
);

filesRoutes.get(
  "/:id",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const [file] = await db.select().from(files).where(eq(files.id, getIdParam(c))).limit(1);
    if (!file) throw new ApiError(404, "file_not_found", "File not found");
    return c.json({ file: toFileObject(file) });
  })
);

filesRoutes.patch(
  "/:id",
  withErrorHandling(async (c) => {
    const body = (await c.req.json()) as { name?: string; parentPath?: string };
    if (body.name === undefined && body.parentPath === undefined) {
      throw new ApiError(400, "validation_error", "Either name or parentPath is required");
    }

    const { db } = await import("edgespark");
    const [existing] = await db.select().from(files).where(eq(files.id, getIdParam(c))).limit(1);
    if (!existing) throw new ApiError(404, "file_not_found", "File not found");

    const nextName = body.name === undefined ? existing.name : normalizeName(body.name);
    const nextParentPath = body.parentPath === undefined ? existing.parentPath : normalizePath(body.parentPath);
    if (existing.isFolder === 1 && (nextParentPath === existing.path || nextParentPath.startsWith(`${existing.path}/`))) {
      throw new ApiError(400, "validation_error", "Cannot move a folder into itself");
    }

    await ensureFolderChain(db, nextParentPath);
    const nextPath = joinPath(nextParentPath, nextName);

    if (nextPath !== existing.path) {
      const [conflict] = await db
        .select()
        .from(files)
        .where(and(eq(files.path, nextPath), ne(files.id, existing.id)))
        .limit(1);
      if (conflict) throw new ApiError(409, "path_conflict", "Path already exists");
    }

    const updatedAt = nowIso();
    await db.update(files).set({ name: nextName, parentPath: nextParentPath, path: nextPath, updatedAt }).where(eq(files.id, existing.id));

    if (existing.isFolder === 1 && nextPath !== existing.path) {
      const descendants = await db.select().from(files).where(like(files.path, descendantPattern(existing.path))).orderBy(asc(files.path));
      for (const item of descendants) {
        const path = `${nextPath}${item.path.slice(existing.path.length)}`;
        await db.update(files).set({ path, parentPath: parentOfPath(path), updatedAt }).where(eq(files.id, item.id));
      }

      const linkedShares = await db
        .select({ id: shares.id, folderPath: shares.folderPath })
        .from(shares)
        .where(or(eq(shares.folderPath, existing.path), like(shares.folderPath, descendantPattern(existing.path))));
      for (const linkedShare of linkedShares) {
        if (!linkedShare.folderPath) continue;
        const updatedFolderPath =
          linkedShare.folderPath === existing.path
            ? nextPath
            : `${nextPath}${linkedShare.folderPath.slice(existing.path.length)}`;
        await db.update(shares).set({ folderPath: updatedFolderPath }).where(eq(shares.id, linkedShare.id));
      }
    }

    const [updated] = await db.select().from(files).where(eq(files.id, existing.id)).limit(1);
    if (!updated) throw new ApiError(404, "file_not_found", "File not found");
    return c.json({ file: toFileObject(updated) });
  })
);

filesRoutes.delete(
  "/:id",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const [target] = await db.select().from(files).where(eq(files.id, getIdParam(c))).limit(1);
    if (!target) throw new ApiError(404, "file_not_found", "File not found");

    const rows =
      target.isFolder === 1
        ? await db.select().from(files).where(or(eq(files.path, target.path), like(files.path, descendantPattern(target.path))))
        : [target];

    const storagePaths = rows
      .filter((x) => x.isFolder === 0 && x.s3Uri)
      .map((x) => storage.tryParseS3Uri(x.s3Uri!))
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .map((x) => x.path);

    if (storagePaths.length > 0) await storage.from(buckets.drive).delete(storagePaths);

    const fileIds = rows.filter((x) => x.isFolder === 0).map((x) => x.id);

    if (target.isFolder === 1) {
      await db.batch([
        db.delete(shares).where(or(eq(shares.folderPath, target.path), like(shares.folderPath, descendantPattern(target.path)))),
        ...(fileIds.length > 0 ? [db.delete(shares).where(inArray(shares.fileId, fileIds))] : []),
        db.delete(files).where(or(eq(files.path, target.path), like(files.path, descendantPattern(target.path)))),
      ]);
      return c.json({ deleted: fileIds.length });
    }

    await db.batch([
      db.delete(shares).where(eq(shares.fileId, target.id)),
      db.delete(files).where(eq(files.id, target.id)),
    ]);
    return c.json({ deleted: 1 });
  })
);
