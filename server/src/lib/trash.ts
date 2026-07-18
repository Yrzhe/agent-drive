import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { buckets, files, shares } from "@defs";
import type { ActivityActor, AppDb, FileRow } from "../types";
import { logEvent } from "./activity";
import {
  deleteBundlePrefixesInSubtree,
  selectPublishedBundleRowsInSubtree,
  unpublishBundlePrefixesInSubtree,
} from "./bundle-prefixes";
import { nowIso } from "./files";
import { escapedDescendantPattern } from "./paths";

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_PURGE_SAMPLE_RATE = 0.01;

/**
 * Trashed subtree roots are renamed into a tombstone namespace
 * (`<path>~trash~<rootId>`, descendants prefix-rewritten) so active paths
 * never collide with trash and creating at a trashed path no longer requires
 * purging it. Restore strips the exact suffix; rows trashed before this
 * scheme keep their original path and restore unchanged.
 */
export const TRASH_PATH_MARKER = "~trash~";

export function tombstonePathFor(path: string, rootId: string): string {
  return `${path}${TRASH_PATH_MARKER}${rootId}`;
}

/** Exact inverse of tombstonePathFor for a trashed subtree ROOT row. */
export function originalTrashPath(root: Pick<FileRow, "path" | "id">): string {
  const suffix = `${TRASH_PATH_MARKER}${root.id}`;
  return root.path.endsWith(suffix) ? root.path.slice(0, -suffix.length) : root.path;
}

/** Display-only: strip tombstone markers anywhere in a path (descendants too). */
export function displayTrashPath(path: string): string {
  return path.replace(/~trash~[A-Za-z0-9_-]+/gu, "");
}

type StorageClient = typeof import("edgespark")["storage"];

function s3PathsFor(rows: readonly FileRow[], storage: StorageClient): string[] {
  return rows
    .filter((x) => x.isFolder === 0 && x.s3Uri)
    .map((x) => storage.tryParseS3Uri(x.s3Uri!))
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .map((x) => x.path);
}

export async function expandSubtree(db: AppDb, root: FileRow): Promise<FileRow[]> {
  if (root.isFolder !== 1) return [root];
  return db
    .select()
    .from(files)
    .where(or(eq(files.path, root.path), sql`${files.path} LIKE ${escapedDescendantPattern(root.path)} ESCAPE '\\'`));
}

export async function softDeleteSubtree(
  db: AppDb,
  root: FileRow,
  options: { actor?: ActivityActor; ownerId?: string | null } = {}
): Promise<{ rows: FileRow[]; fileIds: string[]; unpublishedBundlePublicIds: string[] }> {
  const rows = await expandSubtree(db, root);
  const fileIds = rows.filter((x) => x.isFolder === 0).map((x) => x.id);
  const timestamp = nowIso();
  const publishedBundles = await selectPublishedBundleRowsInSubtree(db, root.path);

  const folderShareCondition =
    root.isFolder === 1
      ? or(eq(shares.folderPath, root.path), sql`${shares.folderPath} LIKE ${escapedDescendantPattern(root.path)} ESCAPE '\\'`)
      : undefined;

  const ops: any[] = [];
  if (publishedBundles.length > 0) ops.push(unpublishBundlePrefixesInSubtree(db, root.path, timestamp));
  if (folderShareCondition) ops.push(db.delete(shares).where(folderShareCondition));
  if (fileIds.length > 0) ops.push(db.delete(shares).where(inArray(shares.fileId, fileIds)));

  const tombRootPath = tombstonePathFor(root.path, root.id);
  for (const row of rows) {
    if (row.deletedAt !== null) continue;
    const nextPath = row.id === root.id ? tombRootPath : `${tombRootPath}${row.path.slice(root.path.length)}`;
    const nextParentPath =
      row.id === root.id
        ? row.parentPath
        : row.parentPath === root.path
          ? tombRootPath
          : `${tombRootPath}${row.parentPath.slice(root.path.length)}`;
    ops.push(
      db
        .update(files)
        .set({ deletedAt: timestamp, updatedAt: timestamp, path: nextPath, parentPath: nextParentPath })
        .where(and(eq(files.id, row.id), isNull(files.deletedAt)))
    );
  }

  if (ops.length === 1) await ops[0];
  else if (ops.length > 1) await db.batch(ops as [any, ...any[]]);

  for (const bundle of publishedBundles) {
    if (!bundle.publicId) continue;
    await logEvent(db, {
      eventType: "bundle.unpublished",
      targetType: "folder",
      targetId: bundle.publicId,
      targetPath: bundle.prefix,
      actor: options.actor ?? "agent",
      metadata: { publicId: bundle.publicId, reason: "trashed" },
      ownerId: options.ownerId ?? null,
    });
  }

  return {
    rows,
    fileIds,
    unpublishedBundlePublicIds: publishedBundles.flatMap((bundle) => bundle.publicId ? [bundle.publicId] : []),
  };
}

export async function restoreSubtree(db: AppDb, root: FileRow): Promise<number> {
  const timestamp = nowIso();
  const originalPath = originalTrashPath(root);
  if (root.isFolder === 1) {
    const rows = await expandSubtree(db, root);
    const ops = rows
      .filter((row) => row.deletedAt !== null)
      .map((row) => {
        const nextPath = row.id === root.id ? originalPath : `${originalPath}${row.path.slice(root.path.length)}`;
        const nextParentPath =
          row.id === root.id
            ? row.parentPath
            : row.parentPath === root.path
              ? originalPath
              : `${originalPath}${row.parentPath.slice(root.path.length)}`;
        return db
          .update(files)
          .set({ deletedAt: null, updatedAt: timestamp, path: nextPath, parentPath: nextParentPath })
          .where(and(eq(files.id, row.id), isNotNull(files.deletedAt)));
      });
    if (ops.length === 1) await ops[0];
    else if (ops.length > 1) await db.batch(ops as [any, ...any[]]);
    return ops.length;
  }
  await db
    .update(files)
    .set({ deletedAt: null, updatedAt: timestamp, path: originalPath })
    .where(eq(files.id, root.id));
  return 1;
}

export async function hardPurgeSubtree(
  db: AppDb,
  storage: StorageClient,
  root: FileRow
): Promise<{ rowCount: number; objectCount: number }> {
  const rows = await expandSubtree(db, root);
  const fileIds = rows.filter((x) => x.isFolder === 0).map((x) => x.id);
  const storagePaths = s3PathsFor(rows, storage);

  if (root.isFolder === 1) {
    const originalBundleRoot = originalTrashPath(root);
    const ops: any[] = [
      deleteBundlePrefixesInSubtree(db, originalBundleRoot),
      db
        .delete(shares)
        .where(or(eq(shares.folderPath, root.path), sql`${shares.folderPath} LIKE ${escapedDescendantPattern(root.path)} ESCAPE '\\'`)),
    ];
    if (originalBundleRoot !== root.path) ops.push(deleteBundlePrefixesInSubtree(db, root.path));
    if (fileIds.length > 0) ops.push(db.delete(shares).where(inArray(shares.fileId, fileIds)));
    ops.push(
      db.delete(files).where(or(eq(files.path, root.path), sql`${files.path} LIKE ${escapedDescendantPattern(root.path)} ESCAPE '\\'`))
    );
    await db.batch(ops as [any, ...any[]]);
  } else {
    await db.batch([
      db.delete(shares).where(eq(shares.fileId, root.id)),
      db.delete(files).where(eq(files.id, root.id)),
    ]);
  }

  // Delete R2 objects only AFTER the DB rows are gone, and best-effort: the logical
  // purge is already committed, so an R2 failure must not fail the request. The
  // failure mode is an ORPHAN object (no DB row references it) — no broken reference,
  // but currently a storage leak (there is no drive-bucket orphan reconciler yet;
  // the pending-upload sweep only reaps `pending:` rows). This is strictly better
  // than the reverse order, which could leave live rows pointing at deleted objects.
  // TODO(#34): reconcile drive-bucket objects against files.s3Uri.
  if (storagePaths.length > 0) {
    try {
      await storage.from(buckets.drive).delete(storagePaths);
    } catch {
      // Orphaned objects remain; DB is already consistent.
    }
  }

  return { rowCount: rows.length, objectCount: storagePaths.length };
}

/**
 * Legacy fallback only: rows trashed before the tombstone-rename scheme still
 * occupy their original path and must be purged before that path can be
 * reused. Rows trashed after the scheme never collide, so this is a no-op.
 */
export async function purgeConflictingTrashAtPath(
  db: AppDb,
  storage: StorageClient,
  path: string
): Promise<boolean> {
  const [trashed] = await db
    .select()
    .from(files)
    .where(and(eq(files.path, path), isNotNull(files.deletedAt)))
    .limit(1);
  if (!trashed) return false;
  await hardPurgeSubtree(db, storage, trashed);
  return true;
}

function cutoffIso(retentionDays: number): string {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

export async function maybePurgeStaleTrash(db: AppDb, storage: StorageClient): Promise<void> {
  if (Math.random() > TRASH_PURGE_SAMPLE_RATE) return;
  const cutoff = cutoffIso(TRASH_RETENTION_DAYS);
  const stale = await db
    .select()
    .from(files)
    .where(and(isNotNull(files.deletedAt), lt(files.deletedAt, cutoff)));
  for (const row of stale) {
    try {
      await hardPurgeSubtree(db, storage, row);
    } catch {
      // best-effort; one bad row shouldn't stop the rest
    }
  }
}

export function trashRetentionInfo(deletedAt: string): { deletedAt: string; purgesAt: string; daysLeft: number } {
  const deleted = new Date(deletedAt).getTime();
  const purges = deleted + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const daysLeft = Math.max(0, Math.ceil((purges - Date.now()) / (24 * 60 * 60 * 1000)));
  return {
    deletedAt,
    purgesAt: new Date(purges).toISOString(),
    daysLeft,
  };
}
