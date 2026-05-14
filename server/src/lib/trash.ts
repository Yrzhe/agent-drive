import { and, eq, inArray, isNotNull, isNull, like, lt, or, sql } from "drizzle-orm";
import { buckets, files, shares } from "@defs";
import type { AppDb, FileRow } from "../types";
import { nowIso } from "./files";
import { descendantPattern } from "./paths";

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_PURGE_SAMPLE_RATE = 0.01;

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
    .where(or(eq(files.path, root.path), like(files.path, descendantPattern(root.path))));
}

export async function softDeleteSubtree(
  db: AppDb,
  root: FileRow
): Promise<{ rows: FileRow[]; fileIds: string[] }> {
  const rows = await expandSubtree(db, root);
  const fileIds = rows.filter((x) => x.isFolder === 0).map((x) => x.id);
  const timestamp = nowIso();

  const folderShareCondition =
    root.isFolder === 1
      ? or(eq(shares.folderPath, root.path), like(shares.folderPath, descendantPattern(root.path)))
      : undefined;

  const ops: any[] = [];
  if (folderShareCondition) ops.push(db.delete(shares).where(folderShareCondition));
  if (fileIds.length > 0) ops.push(db.delete(shares).where(inArray(shares.fileId, fileIds)));

  if (root.isFolder === 1) {
    ops.push(
      db
        .update(files)
        .set({ deletedAt: timestamp, updatedAt: timestamp })
        .where(
          and(
            or(eq(files.path, root.path), like(files.path, descendantPattern(root.path))),
            isNull(files.deletedAt)
          )
        )
    );
  } else {
    ops.push(
      db
        .update(files)
        .set({ deletedAt: timestamp, updatedAt: timestamp })
        .where(and(eq(files.id, root.id), isNull(files.deletedAt)))
    );
  }

  if (ops.length === 1) await ops[0];
  else await db.batch(ops as [any, ...any[]]);

  return { rows, fileIds };
}

export async function restoreSubtree(db: AppDb, root: FileRow): Promise<number> {
  const timestamp = nowIso();
  if (root.isFolder === 1) {
    await db
      .update(files)
      .set({ deletedAt: null, updatedAt: timestamp })
      .where(
        and(
          or(eq(files.path, root.path), like(files.path, descendantPattern(root.path))),
          isNotNull(files.deletedAt)
        )
      );
    const restored = await db
      .select({ id: files.id })
      .from(files)
      .where(or(eq(files.path, root.path), like(files.path, descendantPattern(root.path))));
    return restored.length;
  }
  await db
    .update(files)
    .set({ deletedAt: null, updatedAt: timestamp })
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

  if (storagePaths.length > 0) await storage.from(buckets.drive).delete(storagePaths);

  if (root.isFolder === 1) {
    const ops: any[] = [
      db
        .delete(shares)
        .where(or(eq(shares.folderPath, root.path), like(shares.folderPath, descendantPattern(root.path)))),
    ];
    if (fileIds.length > 0) ops.push(db.delete(shares).where(inArray(shares.fileId, fileIds)));
    ops.push(
      db.delete(files).where(or(eq(files.path, root.path), like(files.path, descendantPattern(root.path))))
    );
    await db.batch(ops as [any, ...any[]]);
  } else {
    await db.batch([
      db.delete(shares).where(eq(shares.fileId, root.id)),
      db.delete(files).where(eq(files.id, root.id)),
    ]);
  }

  return { rowCount: rows.length, objectCount: storagePaths.length };
}

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

// drizzle-orm 1.x ESM helpers used elsewhere are re-exported via @defs; sql import kept for future use
void sql;
