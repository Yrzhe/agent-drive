import { getPlatform } from "@platform";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { buckets, files } from "@defs";
import { getRequestActor, logEvent } from "./activity";
import { ensureFolderChain, isPathUniqueConflict, nowIso, toFileObject } from "./files";
import { ApiError } from "./errors";
import { joinPath, normalizeName, normalizePath } from "./paths";
import { driveObjectKey, presignPath } from "./object-keys";
import { createPendingUploadMarker, readPendingUploadDeclaredSize, readPendingUploadObjectKey } from "./pending-marker";
import { reclaimStalePendingUpload } from "./pending-uploads";
import { checkFileSize, checkTotalQuota } from "./quota";
import { purgeConflictingTrashAtPath } from "./trash";
import { PRESIGNED_URL_TTL_SECS } from "../types";

const FILE_SIZE_TOLERANCE_RATIO = 0.1;

function isFileSizeWithinTolerance(expected: number, actual: number): boolean {
  const diff = Math.abs(actual - expected);
  const tolerance = expected * FILE_SIZE_TOLERANCE_RATIO;
  return diff <= tolerance;
}

export async function prepareFileUpload(body: { filename?: string; contentType?: string; size?: number; path?: string }, ownerId: string | null, assertPathAllowed: (path: string) => void) {
  const filename = normalizeName(body.filename);
  const contentType = (body.contentType ?? "application/octet-stream").trim();
  const declaredSize = Number(body.size);
  if (!contentType) throw new ApiError(400, "validation_error", "contentType is required");
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    throw new ApiError(400, "validation_error", "size must be a non-negative safe integer");
  }

  const parentPath = normalizePath(body.path ?? "/");
  const targetPath = joinPath(parentPath, filename);
  assertPathAllowed(targetPath);

  const { db, storage } = await getPlatform();

  const fileSizeCheck = await checkFileSize(declaredSize);
  if (!fileSizeCheck.ok) throw new ApiError(413, fileSizeCheck.code, fileSizeCheck.message);
  const quotaCheck = await checkTotalQuota(db, declaredSize);
  if (!quotaCheck.ok) throw new ApiError(413, quotaCheck.code, quotaCheck.message);

  await ensureFolderChain(db, parentPath, ownerId);

  await purgeConflictingTrashAtPath(db, storage, targetPath, ownerId);
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
      s3Uri: createPendingUploadMarker(declaredSize, objectPath),
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerId: ownerId,
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

  return {
    fileId,
    filename,
    path: parentPath,
    uploadUrl: presigned.uploadUrl,
    requiredHeaders: presigned.requiredHeaders,
    expiresAt: presigned.expiresAt.toISOString(),
    ...(presigned.multipart ? { multipart: presigned.multipart } : {}),
  };
}

export async function completeFileUpload(body: { fileId?: string; filename?: string; path?: string }, ownerId: string | null, assertPathAllowed: (path: string) => void) {
  const fileId = (body.fileId ?? "").trim();
  if (!fileId) throw new ApiError(400, "validation_error", "fileId is required");

  const filename = normalizeName(body.filename);
  const parentPath = normalizePath(body.path ?? "/");
  const targetPath = joinPath(parentPath, filename);
  assertPathAllowed(targetPath);

  const { db, storage } = await getPlatform();
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

  // Resolve the key the presigned PUT actually targeted, not the current name —
  // a rename after /upload (e.g. to clear a restore path-conflict) must not
  // desync the two (#50). Old-format markers carry no key; fall back to the
  // name-derived key for backward compat with rows created before this change.
  const objectPath = readPendingUploadObjectKey(pendingMarker) ?? driveObjectKey(fileId, filename);
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
    ownerId: ownerId,
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

  return { file: toFileObject(inserted) };
}
