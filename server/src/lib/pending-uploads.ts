import { and, eq, isNull, like, lt } from "drizzle-orm";

import { buckets, files } from "@defs";

import { driveObjectKey } from "./object-keys";
import { PENDING_UPLOAD_PREFIX, readPendingUploadObjectKey } from "./pending-marker";
import type { AppDb, FileRow } from "../types";

type StorageClient = typeof import("edgespark")["storage"];

/** Abandoned pending rows/objects are reaped by the background sweep after this. */
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
/** A pending row can be reclaimed by a fresh /upload once its PUT URL has expired. */
const PENDING_RECLAIM_AFTER_MS = 60 * 60 * 1000; // matches PRESIGNED_URL_TTL_SECS
const PENDING_PURGE_SAMPLE_RATE = 0.05;

function isPendingRow(row: Pick<FileRow, "size" | "s3Uri">): boolean {
  return row.size === 0 && typeof row.s3Uri === "string" && row.s3Uri.startsWith(PENDING_UPLOAD_PREFIX);
}

// A row's name can change after /upload (e.g. PATCH rename to clear a restore
// path-conflict) without changing the R2 key the presigned PUT actually
// targeted. Resolve from the marker's stored key first; only rows created
// before #50 (no key segment in the marker) fall back to the name-derived key.
function pendingObjectPath(row: Pick<FileRow, "id" | "name" | "s3Uri">): string {
  return readPendingUploadObjectKey(row.s3Uri) ?? driveObjectKey(row.id, row.name);
}

/** Returns true only if a still-pending row was claimed and removed. */
async function purgePendingRow(db: AppDb, storage: StorageClient, row: FileRow): Promise<boolean> {
  // Atomically claim the row ONLY while it is still pending. If /upload/complete or
  // an overwrite installed a real object between our classification (SELECT) and now,
  // this DELETE matches 0 rows — the row is a live completed file and its R2 object
  // (same key) must NOT be touched. Deleting R2 only after winning the claim closes
  // the TOCTOU where cleanup would erase a just-completed file.
  const claimed = await db
    .delete(files)
    .where(and(eq(files.id, row.id), eq(files.size, 0), like(files.s3Uri, `${PENDING_UPLOAD_PREFIX}%`)))
    .returning({ id: files.id });
  if (claimed.length === 0) return false;
  try {
    await storage.from(buckets.drive).delete(pendingObjectPath(row));
  } catch {
    // The client may never have PUT the object — deleting a missing key is fine.
  }
  return true;
}

/**
 * Reclaim a stale pending row occupying a path a new upload wants. Only reclaims
 * once the original PUT URL has expired (so we never kill an in-flight upload).
 * Returns true if the path was freed.
 */
export async function reclaimStalePendingUpload(db: AppDb, storage: StorageClient, row: FileRow): Promise<boolean> {
  if (!isPendingRow(row)) return false;
  if (Date.parse(row.createdAt) >= Date.now() - PENDING_RECLAIM_AFTER_MS) return false;
  // Returns false if the row was completed concurrently — the path is genuinely taken.
  return purgePendingRow(db, storage, row);
}

/**
 * Opportunistic, sampled sweep of abandoned pending-upload rows (size 0, `pending:`
 * marker) older than the TTL, plus their orphaned R2 objects. Best-effort — one bad
 * row never blocks the rest. Mirrors `maybePurgeStaleTrash`; no cron needed.
 */
export async function maybePurgeStalePendingUploads(db: AppDb, storage: StorageClient): Promise<void> {
  if (Math.random() > PENDING_PURGE_SAMPLE_RATE) return;
  const cutoff = new Date(Date.now() - PENDING_UPLOAD_TTL_MS).toISOString();
  const stale = await db
    .select()
    .from(files)
    .where(and(
      isNull(files.deletedAt),
      eq(files.size, 0),
      like(files.s3Uri, `${PENDING_UPLOAD_PREFIX}%`),
      lt(files.createdAt, cutoff),
    ));
  for (const row of stale) {
    try {
      await purgePendingRow(db, storage, row);
    } catch {
      // best-effort; keep sweeping
    }
  }
}
