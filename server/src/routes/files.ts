import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { buckets, files, shares } from "@defs";
import { getRequestActor, logEvent } from "../lib/activity";
import { rewriteBundlePrefixesForMove } from "../lib/bundle-prefixes";
import { ensureFolderChain, nowIso, toFileObject } from "../lib/files";
import { ApiError, withErrorHandling } from "../lib/errors";
import { escapedDescendantPattern, joinPath, normalizeName, normalizePath, parentOfPath } from "../lib/paths";
import { parseListPagination } from "../lib/pagination";
import { driveObjectKey, presignPath } from "../lib/object-keys";
import { maybeReconcileOrphanObjects } from "../lib/orphan-objects";
import { maybePurgeStalePendingUploads, reclaimStalePendingUpload } from "../lib/pending-uploads";
import { checkFileSize, checkTotalQuota } from "../lib/quota";
import { assertRestListPathAllowed, assertRestPathAllowed, restPathFilter } from "../lib/rest-scopes";
import {
  displayTrashPath,
  hardPurgeSubtree,
  maybePurgeStaleTrash,
  originalTrashPath,
  purgeConflictingTrashAtPath,
  restoreSubtree,
  softDeleteSubtree,
  trashRetentionInfo,
} from "../lib/trash";
import { PRESIGNED_URL_TTL_SECS, PREVIEW_URL_TTL_SECS, type AppEnv } from "../types";

export const filesRoutes = new Hono<AppEnv>();
const PENDING_UPLOAD_PREFIX = "pending:";
const FILE_SIZE_TOLERANCE_RATIO = 0.1;

function isPathUniqueConflict(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message?.toLowerCase() ?? "";
  return message.includes("unique constraint failed: files.path") || (message.includes("duplicate key") && message.includes("files.path"));
}

function createPendingUploadMarker(declaredSize: number): string {
  return `${PENDING_UPLOAD_PREFIX}${declaredSize}`;
}

function readPendingUploadDeclaredSize(marker: string | null): number | null {
  if (!marker || !marker.startsWith(PENDING_UPLOAD_PREFIX)) return null;
  const size = Number(marker.slice(PENDING_UPLOAD_PREFIX.length));
  return Number.isFinite(size) && size >= 0 ? size : null;
}

function isFileSizeWithinTolerance(expected: number, actual: number): boolean {
  const diff = Math.abs(actual - expected);
  const tolerance = expected * FILE_SIZE_TOLERANCE_RATIO;
  return diff <= tolerance;
}

function getIdParam(c: { req: { param: (name: string) => string | undefined } }): string {
  const id = c.req.param("id");
  if (!id) throw new ApiError(400, "validation_error", "Missing path param: id");
  return id;
}

function escapeLikeQuery(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Canonical key + presign encoding now live in lib/object-keys.ts (see #44).

filesRoutes.post(
  "/upload",
  withErrorHandling(async (c) => {
    const body = (await c.req.json()) as { filename?: string; contentType?: string; size?: number; path?: string };
    const filename = normalizeName(body.filename);
    const contentType = (body.contentType ?? "application/octet-stream").trim();
    const declaredSize = Number(body.size);
    if (!contentType) throw new ApiError(400, "validation_error", "contentType is required");
    if (!Number.isFinite(declaredSize) || declaredSize < 0) {
      throw new ApiError(400, "validation_error", "size must be a non-negative number");
    }

    const parentPath = normalizePath(body.path ?? "/");
    const targetPath = joinPath(parentPath, filename);
    assertRestPathAllowed(c, targetPath);

    const { db, storage } = await import("edgespark");

    const fileSizeCheck = await checkFileSize(declaredSize);
    if (!fileSizeCheck.ok) throw new ApiError(413, fileSizeCheck.code, fileSizeCheck.message);
    const quotaCheck = await checkTotalQuota(db, declaredSize);
    if (!quotaCheck.ok) throw new ApiError(413, quotaCheck.code, quotaCheck.message);

    await ensureFolderChain(db, parentPath, c.get("ownerId") ?? null);

    const ownerId = c.get("ownerId") ?? null;
    await purgeConflictingTrashAtPath(db, storage, targetPath);
    const [conflict] = await db
      .select()
      .from(files)
      .where(and(eq(files.path, targetPath), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
      .limit(1);
    if (conflict) {
      // An abandoned pending upload can squat the path; reclaim it once its PUT URL
      // has expired, otherwise the path is genuinely taken.
      const reclaimed = await reclaimStalePendingUpload(db, storage, conflict);
      if (!reclaimed) throw new ApiError(409, "path_conflict", "Path already exists");
    }

    const fileId = nanoid();
    const objectPath = driveObjectKey(fileId, filename);
    const timestamp = nowIso();
    try {
      await db.insert(files).values({
        id: fileId,
        name: filename,
        path: targetPath,
        parentPath,
        isFolder: 0,
        size: 0,
        contentType,
        s3Uri: createPendingUploadMarker(declaredSize),
        createdAt: timestamp,
        updatedAt: timestamp,
        ownerId: c.get("ownerId") ?? null,
      });
    } catch (error) {
      if (isPathUniqueConflict(error)) {
        throw new ApiError(409, "path_conflict", "Path already exists");
      }
      throw error;
    }

    const presigned = await storage.from(buckets.drive).createPresignedPutUrl(presignPath(objectPath), PRESIGNED_URL_TTL_SECS, {
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
    const targetPath = joinPath(parentPath, filename);
    assertRestPathAllowed(c, targetPath);

    const { db, storage } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const [pending] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), ownerId ? eq(files.ownerId, ownerId) : undefined))
      .limit(1);
    if (!pending || pending.isFolder !== 0 || pending.size !== 0) {
      throw new ApiError(400, "invalid_upload_ticket", "Upload ticket is invalid or already completed");
    }
    if (pending.path !== targetPath || pending.parentPath !== parentPath || pending.name !== filename) {
      throw new ApiError(409, "path_conflict", "Upload ticket does not match the target path");
    }

    const pendingMarker = pending.s3Uri;
    if (!pendingMarker) {
      throw new ApiError(400, "invalid_upload_ticket", "Upload ticket metadata is invalid");
    }
    const declaredSize = readPendingUploadDeclaredSize(pendingMarker);
    if (declaredSize === null) {
      throw new ApiError(400, "invalid_upload_ticket", "Upload ticket metadata is invalid");
    }

    const objectPath = driveObjectKey(fileId, filename);
    const metadata = await storage.from(buckets.drive).head(objectPath);
    if (!metadata) throw new ApiError(404, "upload_not_found", "Uploaded file not found in storage");

    if (!isFileSizeWithinTolerance(declaredSize, metadata.size)) {
      throw new ApiError(400, "size_mismatch", "Uploaded file size differs too much from declared size");
    }

    // Authoritative limit enforcement on the REAL uploaded size. The declared-size
    // gate at /upload is advisory; here the object is in R2, so reject + clean it up
    // (object + pending row) if it breaches the per-file limit or total quota.
    for (const check of [await checkFileSize(metadata.size), await checkTotalQuota(db, metadata.size)]) {
      if (!check.ok) {
        await storage.from(buckets.drive).delete(objectPath);
        await db.delete(files).where(eq(files.id, fileId));
        throw new ApiError(413, check.code, check.message);
      }
    }

    const timestamp = nowIso();
    const completed = await db
      .update(files)
      .set({
        size: metadata.size,
        contentType: metadata.contentType ?? pending.contentType ?? null,
        s3Uri: storage.createS3Uri(buckets.drive, objectPath),
        updatedAt: timestamp,
      })
      .where(and(eq(files.id, fileId), eq(files.size, 0), eq(files.s3Uri, pendingMarker)))
      .returning();
    const [inserted] = completed;
    if (!inserted) throw new ApiError(409, "upload_state_conflict", "Upload ticket was already completed");

    await logEvent(db, {
      ownerId: c.get("ownerId") ?? null,
      eventType: "file.uploaded",
      targetType: "file",
      targetId: inserted.id,
      targetPath: inserted.path,
      actor: await getRequestActor(),
      metadata: {
        size: inserted.size,
        contentType: inserted.contentType,
      },
    });

    return c.json({ file: toFileObject(inserted) });
  })
);

filesRoutes.get(
  "/",
  withErrorHandling(async (c) => {
    const path = normalizePath(c.req.query("path") ?? "/");
    const recursive = c.req.query("recursive") === "true";
    const limitRaw = Number(c.req.query("limit") ?? "100");
    const offsetRaw = Number(c.req.query("offset") ?? "0");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.trunc(limitRaw))) : 100;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;
    assertRestListPathAllowed(c, path);
    const pathVisible = restPathFilter(c);
    const { db } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;

    const result = recursive
      ? path === "/"
        ? await db.select().from(files).where(and(isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined)).orderBy(asc(files.path)).limit(limit).offset(offset)
        : await db.select().from(files).where(and(sql`${files.path} LIKE ${escapedDescendantPattern(path)} ESCAPE '\\'`, isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined)).orderBy(asc(files.path)).limit(limit).offset(offset)
      : await db.select().from(files).where(and(eq(files.parentPath, path), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined)).orderBy(desc(files.isFolder), asc(files.name)).limit(limit).offset(offset);

    return c.json({ files: result.filter((row) => pathVisible(row.path)).map(toFileObject), path, limit, offset });
  })
);

filesRoutes.get(
  "/search",
  withErrorHandling(async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;
    if (query.length < 2) {
      return c.json({ files: [], query, count: 0 });
    }

    const pattern = `%${escapeLikeQuery(query)}%`;
    const { db } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const result = await db
      .select()
      .from(files)
      .where(
        and(
          or(
            sql`${files.name} LIKE ${pattern} ESCAPE '\\'`,
            sql`${files.path} LIKE ${pattern} ESCAPE '\\'`
          ),
          isNull(files.deletedAt),
          ownerId ? eq(files.ownerId, ownerId) : undefined
        )
      )
      .orderBy(desc(files.isFolder), asc(files.name))
      .limit(limit);

    const pathVisible = restPathFilter(c);
    const visible = result.filter((row) => pathVisible(row.path));
    return c.json({ files: visible.map(toFileObject), query, count: visible.length });
  })
);

const BATCH_MAX_IDS = 200;

function normalizeBatchIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "validation_error", "ids must be an array of strings");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string") {
      throw new ApiError(400, "validation_error", "ids must contain strings only");
    }
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  if (ids.length === 0) {
    throw new ApiError(400, "validation_error", "ids must include at least one identifier");
  }
  if (ids.length > BATCH_MAX_IDS) {
    throw new ApiError(400, "validation_error", `Too many ids (max ${BATCH_MAX_IDS})`);
  }
  return ids;
}

interface BatchFailure {
  id: string;
  error: string;
  message: string;
}

filesRoutes.delete(
  "/batch",
  withErrorHandling(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = normalizeBatchIds(body.ids);

    const { db, storage } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const targets = await db
      .select()
      .from(files)
      .where(and(inArray(files.id, ids), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined));
    const byId = new Map(targets.map((t) => [t.id, t]));
    const failures: BatchFailure[] = [];
    const trashedFileIds: string[] = [];
    const trashedFolderIds: string[] = [];
    const actor = await getRequestActor();
    const pathVisible = restPathFilter(c);

    for (const id of ids) {
      const target = byId.get(id);
      if (!target) {
        failures.push({ id, error: "file_not_found", message: "File not found" });
        continue;
      }
      if (!pathVisible(target.path)) {
        failures.push({ id, error: "invalid_scope", message: `invalid_scope:path:${target.path}` });
        continue;
      }
      try {
        const { rows, fileIds: childFileIds } = await softDeleteSubtree(db, target, { actor, ownerId: c.get("ownerId") ?? null });
        if (target.isFolder === 1) {
          trashedFolderIds.push(target.id);
          await logEvent(db, {
            ownerId: c.get("ownerId") ?? null,
            eventType: "file.trashed",
            targetType: "folder",
            targetId: target.id,
            targetPath: target.path,
            actor,
            metadata: { trashedFiles: childFileIds.length, trashedPaths: rows.length, batch: true },
          });
        } else {
          trashedFileIds.push(target.id);
          await logEvent(db, {
            ownerId: c.get("ownerId") ?? null,
            eventType: "file.trashed",
            targetType: "file",
            targetId: target.id,
            targetPath: target.path,
            actor,
            metadata: { size: target.size, batch: true },
          });
        }
      } catch (error) {
        failures.push({
          id,
          error: "delete_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await maybePurgeStaleTrash(db, storage);
    await maybePurgeStalePendingUploads(db, storage);
    await maybeReconcileOrphanObjects(db, storage);

    return c.json({
      requested: ids.length,
      trashedFiles: trashedFileIds.length,
      trashedFolders: trashedFolderIds.length,
      trashedIds: [...trashedFileIds, ...trashedFolderIds],
      failures,
    });
  })
);

filesRoutes.patch(
  "/batch",
  withErrorHandling(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; parentPath?: unknown };
    const ids = normalizeBatchIds(body.ids);
    if (typeof body.parentPath !== "string") {
      throw new ApiError(400, "validation_error", "parentPath is required");
    }
    const nextParentPath = normalizePath(body.parentPath);
    // Destination scope check must precede ensureFolderChain — it creates (or
    // un-trashes) folder rows as a side effect.
    assertRestPathAllowed(c, nextParentPath);

    const { db, storage } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    await ensureFolderChain(db, nextParentPath, c.get("ownerId") ?? null);

    const targets = await db
      .select()
      .from(files)
      .where(and(inArray(files.id, ids), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined));
    const byId = new Map(targets.map((t) => [t.id, t]));
    const failures: BatchFailure[] = [];
    const movedIds: string[] = [];
    const updatedAt = nowIso();
    const actor = await getRequestActor();
    const pathVisible = restPathFilter(c);

    for (const id of ids) {
      const existing = byId.get(id);
      if (!existing) {
        failures.push({ id, error: "file_not_found", message: "File not found" });
        continue;
      }
      if (!pathVisible(existing.path) || !pathVisible(joinPath(nextParentPath, existing.name))) {
        failures.push({ id, error: "invalid_scope", message: `invalid_scope:path:${existing.path}` });
        continue;
      }
      try {
        if (existing.isFolder === 1 && (nextParentPath === existing.path || nextParentPath.startsWith(`${existing.path}/`))) {
          failures.push({ id, error: "validation_error", message: "Cannot move a folder into itself" });
          continue;
        }
        if (existing.parentPath === nextParentPath) {
          movedIds.push(id);
          continue;
        }

        const nextPath = joinPath(nextParentPath, existing.name);
        await purgeConflictingTrashAtPath(db, storage, nextPath);
        const [conflict] = await db
          .select()
          .from(files)
          .where(and(eq(files.path, nextPath), ne(files.id, existing.id), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
          .limit(1);
        if (conflict) {
          failures.push({ id, error: "path_conflict", message: `Path already exists: ${nextPath}` });
          continue;
        }

        const rootUpdate = db.update(files).set({ parentPath: nextParentPath, path: nextPath, updatedAt }).where(eq(files.id, existing.id));

        if (existing.isFolder === 1) {
          const descendants = await db.select().from(files).where(and(sql`${files.path} LIKE ${escapedDescendantPattern(existing.path)} ESCAPE '\\'`, ownerId ? eq(files.ownerId, ownerId) : undefined)).orderBy(asc(files.path));
          const descendantUpdates = descendants.map((item) => {
            const path = `${nextPath}${item.path.slice(existing.path.length)}`;
            return db.update(files).set({ path, parentPath: parentOfPath(path), updatedAt }).where(eq(files.id, item.id));
          });

          const linkedShares = await db
            .select({ id: shares.id, folderPath: shares.folderPath })
            .from(shares)
            .where(or(eq(shares.folderPath, existing.path), sql`${shares.folderPath} LIKE ${escapedDescendantPattern(existing.path)} ESCAPE '\\'`));
          const shareUpdates = linkedShares.flatMap((linkedShare) => {
            if (!linkedShare.folderPath) return [];
            const updatedFolderPath =
              linkedShare.folderPath === existing.path
                ? nextPath
                : `${nextPath}${linkedShare.folderPath.slice(existing.path.length)}`;
            return [db.update(shares).set({ folderPath: updatedFolderPath }).where(eq(shares.id, linkedShare.id))];
          });

          const bundleUpdates = [rewriteBundlePrefixesForMove(db, existing.path, nextPath, updatedAt)];
          // Rewrite root + every descendant + share + bundle path in ONE atomic batch,
          // so a mid-move failure can't leave children pointing at the old prefix.
          const updates = [rootUpdate, ...descendantUpdates, ...shareUpdates, ...bundleUpdates];
          await db.batch(updates as [typeof updates[number], ...Array<typeof updates[number]>]);
        } else {
          await rootUpdate;
        }

        movedIds.push(existing.id);
        await logEvent(db, {
          ownerId: c.get("ownerId") ?? null,
          eventType: "file.moved",
          targetType: existing.isFolder === 1 ? "folder" : "file",
          targetId: existing.id,
          targetPath: nextPath,
          actor,
          metadata: {
            previousParentPath: existing.parentPath,
            nextParentPath,
            previousPath: existing.path,
            nextPath,
            batch: true,
          },
        });
      } catch (error) {
        failures.push({
          id,
          error: "move_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return c.json({
      requested: ids.length,
      moved: movedIds.length,
      movedIds,
      parentPath: nextParentPath,
      failures,
    });
  })
);

filesRoutes.get(
  "/trash",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const { limit, offset } = parseListPagination((name) => c.req.query(name), { defaultLimit: 100, maxLimit: 500 });
    const rows = await db
      .select()
      .from(files)
      .where(and(isNotNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
      .orderBy(desc(files.deletedAt))
      .limit(limit)
      .offset(offset);
    // Path-scoped bearers may see short pages: scope filtering happens after
    // the SQL page (documented in the API reference).
    const pathVisible = restPathFilter(c);
    return c.json({
      files: rows
        .filter((row) => pathVisible(displayTrashPath(row.path)))
        .map((row) => ({
          ...toFileObject(row),
          path: displayTrashPath(row.path),
          parentPath: displayTrashPath(row.parentPath),
          deletedAt: row.deletedAt,
          retention: row.deletedAt ? trashRetentionInfo(row.deletedAt) : null,
        })),
      retentionDays: 30,
      limit,
      offset,
    });
  })
);

filesRoutes.get(
  "/:id",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, getIdParam(c)), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
      .limit(1);
    if (!file) throw new ApiError(404, "file_not_found", "File not found");
    assertRestPathAllowed(c, file.path);
    return c.json({ file: toFileObject(file) });
  })
);

filesRoutes.get(
  "/:id/preview",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, getIdParam(c)), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
      .limit(1);
    if (!file) throw new ApiError(404, "file_not_found", "File not found");
    assertRestPathAllowed(c, file.path);
    if (file.isFolder === 1) throw new ApiError(400, "validation_error", "Folders cannot be previewed");
    if (!file.s3Uri) throw new ApiError(409, "upload_pending", "File has not finished uploading");
    const parsed = storage.tryParseS3Uri(file.s3Uri);
    if (!parsed) throw new ApiError(500, "storage_error", "Invalid storage URI");
    const { downloadUrl } = await storage.from(buckets.drive).createPresignedGetUrl(presignPath(parsed.path), PREVIEW_URL_TTL_SECS);
    return c.json({
      id: file.id,
      name: file.name,
      contentType: file.contentType,
      size: file.size,
      downloadUrl,
      expiresInSecs: PREVIEW_URL_TTL_SECS,
    });
  })
);

filesRoutes.patch(
  "/:id",
  withErrorHandling(async (c) => {
    const body = (await c.req.json()) as { name?: string; parentPath?: string };
    if (body.name === undefined && body.parentPath === undefined) {
      throw new ApiError(400, "validation_error", "Either name or parentPath is required");
    }

    const { db, storage } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const [existing] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, getIdParam(c)), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
      .limit(1);
    if (!existing) throw new ApiError(404, "file_not_found", "File not found");
    assertRestPathAllowed(c, existing.path);

    const nextName = body.name === undefined ? existing.name : normalizeName(body.name);
    const nextParentPath = body.parentPath === undefined ? existing.parentPath : normalizePath(body.parentPath);
    if (existing.isFolder === 1 && (nextParentPath === existing.path || nextParentPath.startsWith(`${existing.path}/`))) {
      throw new ApiError(400, "validation_error", "Cannot move a folder into itself");
    }

    const nextPath = joinPath(nextParentPath, nextName);
    assertRestPathAllowed(c, nextPath);
    await ensureFolderChain(db, nextParentPath, c.get("ownerId") ?? null);

    if (nextPath !== existing.path) {
      await purgeConflictingTrashAtPath(db, storage, nextPath);
      const [conflict] = await db
        .select()
        .from(files)
        .where(and(eq(files.path, nextPath), ne(files.id, existing.id), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
        .limit(1);
      if (conflict) throw new ApiError(409, "path_conflict", "Path already exists");
    }

    const updatedAt = nowIso();
    const rootUpdate = db.update(files).set({ name: nextName, parentPath: nextParentPath, path: nextPath, updatedAt }).where(eq(files.id, existing.id));

    if (existing.isFolder === 1 && nextPath !== existing.path) {
      const descendants = await db.select().from(files).where(and(sql`${files.path} LIKE ${escapedDescendantPattern(existing.path)} ESCAPE '\\'`, ownerId ? eq(files.ownerId, ownerId) : undefined)).orderBy(asc(files.path));
      const descendantUpdates = descendants.map((item) => {
        const path = `${nextPath}${item.path.slice(existing.path.length)}`;
        return db.update(files).set({ path, parentPath: parentOfPath(path), updatedAt }).where(eq(files.id, item.id));
      });

      const linkedShares = await db
        .select({ id: shares.id, folderPath: shares.folderPath })
        .from(shares)
        .where(or(eq(shares.folderPath, existing.path), sql`${shares.folderPath} LIKE ${escapedDescendantPattern(existing.path)} ESCAPE '\\'`));
      const shareUpdates = linkedShares.flatMap((linkedShare) => {
        if (!linkedShare.folderPath) return [];
        const updatedFolderPath =
          linkedShare.folderPath === existing.path
            ? nextPath
            : `${nextPath}${linkedShare.folderPath.slice(existing.path.length)}`;
        return [db.update(shares).set({ folderPath: updatedFolderPath }).where(eq(shares.id, linkedShare.id))];
      });

      const bundleUpdates = [rewriteBundlePrefixesForMove(db, existing.path, nextPath, updatedAt)];
      // Root + descendants + shares + bundles rewritten in ONE atomic batch.
      const updates = [rootUpdate, ...descendantUpdates, ...shareUpdates, ...bundleUpdates];
      await db.batch(updates as [typeof updates[number], ...Array<typeof updates[number]>]);
    } else {
      await rootUpdate;
    }

    const [updated] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, existing.id), ownerId ? eq(files.ownerId, ownerId) : undefined))
      .limit(1);
    if (!updated) throw new ApiError(404, "file_not_found", "File not found");

    const actor = await getRequestActor();
    const targetType = updated.isFolder === 1 ? "folder" : "file";
    if (existing.name !== updated.name) {
      await logEvent(db, {
        ownerId: c.get("ownerId") ?? null,
        eventType: "file.renamed",
        targetType,
        targetId: updated.id,
        targetPath: updated.path,
        actor,
        metadata: {
          previousName: existing.name,
          nextName: updated.name,
          previousPath: existing.path,
          nextPath: updated.path,
        },
      });
    }
    if (existing.parentPath !== updated.parentPath) {
      await logEvent(db, {
        ownerId: c.get("ownerId") ?? null,
        eventType: "file.moved",
        targetType,
        targetId: updated.id,
        targetPath: updated.path,
        actor,
        metadata: {
          previousParentPath: existing.parentPath,
          nextParentPath: updated.parentPath,
          previousPath: existing.path,
          nextPath: updated.path,
        },
      });
    }

    return c.json({ file: toFileObject(updated) });
  })
);

filesRoutes.delete(
  "/:id",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const [target] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, getIdParam(c)), isNull(files.deletedAt)))
      .limit(1);
    if (!target) throw new ApiError(404, "file_not_found", "File not found");
    assertRestPathAllowed(c, target.path);

    const actor = await getRequestActor();
    const { rows, fileIds } = await softDeleteSubtree(db, target, { actor, ownerId: c.get("ownerId") ?? null });
    await maybePurgeStaleTrash(db, storage);
    await maybePurgeStalePendingUploads(db, storage);
    await maybeReconcileOrphanObjects(db, storage);

    const targetType = target.isFolder === 1 ? "folder" : "file";
    await logEvent(db, {
      ownerId: c.get("ownerId") ?? null,
      eventType: "file.trashed",
      targetType,
      targetId: target.id,
      targetPath: target.path,
      actor,
      metadata:
        target.isFolder === 1
          ? { trashedFiles: fileIds.length, trashedPaths: rows.length }
          : { size: target.size },
    });
    return c.json({ trashed: target.isFolder === 1 ? fileIds.length : 1, targetId: target.id });
  })
);

filesRoutes.post(
  "/:id/restore",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const [target] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, getIdParam(c)), isNotNull(files.deletedAt)))
      .limit(1);
    if (!target) throw new ApiError(404, "file_not_found", "Trashed item not found");

    const originalPath = originalTrashPath(target);
    assertRestPathAllowed(c, originalPath);
    const [conflict] = await db
      .select()
      .from(files)
      .where(and(eq(files.path, originalPath), ne(files.id, target.id), isNull(files.deletedAt)))
      .limit(1);
    if (conflict) {
      throw new ApiError(409, "path_conflict", `An item already exists at ${originalPath}. Rename or move it before restoring.`);
    }

    await ensureFolderChain(db, target.parentPath, c.get("ownerId") ?? null);
    const restored = await restoreSubtree(db, target);
    await maybePurgeStaleTrash(db, storage);
    await maybePurgeStalePendingUploads(db, storage);
    await maybeReconcileOrphanObjects(db, storage);

    await logEvent(db, {
      ownerId: c.get("ownerId") ?? null,
      eventType: "file.restored",
      targetType: target.isFolder === 1 ? "folder" : "file",
      targetId: target.id,
      targetPath: originalPath,
      actor: await getRequestActor(),
      metadata: { restoredPaths: restored },
    });
    return c.json({ restored, file: toFileObject({ ...target, path: originalPath, deletedAt: null }) });
  })
);

filesRoutes.delete(
  "/:id/purge",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const [target] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, getIdParam(c)), isNotNull(files.deletedAt)))
      .limit(1);
    if (!target) throw new ApiError(404, "file_not_found", "Trashed item not found");
    assertRestPathAllowed(c, originalTrashPath(target));

    const { rowCount, objectCount } = await hardPurgeSubtree(db, storage, target);
    await logEvent(db, {
      ownerId: c.get("ownerId") ?? null,
      eventType: "file.purged",
      targetType: target.isFolder === 1 ? "folder" : "file",
      targetId: target.id,
      targetPath: displayTrashPath(target.path),
      actor: await getRequestActor(),
      metadata: { rowCount, objectCount },
    });
    return c.json({ purged: rowCount, objectsRemoved: objectCount });
  })
);
