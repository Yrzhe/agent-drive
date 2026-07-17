import { inArray } from "drizzle-orm";

import { buckets, files } from "@defs";

import type { AppDb } from "../types";

type StorageClient = typeof import("edgespark")["storage"];

/**
 * An object younger than this is never reaped. Server-side writers (MCP `write_file`,
 * inbox delivery, bundle manifest/history) PUT the object *before* inserting its row,
 * so a legitimately-new object can briefly have no row. Presigned uploads are already
 * safe — `/upload` inserts the pending row before it hands out the PUT URL — so this
 * window only has to cover the server-side put→insert gap. 24 h is deliberate overkill.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** nanoid v5 default alphabet — every drive object key starts `${fileId}/`. */
const ID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const ORPHAN_SWEEP_SAMPLE_RATE = 0.02;
const ORPHAN_SWEEP_LIMIT = 500;

/** Every drive key is `/` (see lib/object-keys.ts) — take the owning id. */
function fileIdOf(objectPath: string): string | null {
  const slash = objectPath.indexOf("/");
  if (slash <= 0) return null;
  return objectPath.slice(0, slash);
}

/**
 * Delete drive-bucket objects whose owning `files` row no longer exists.
 *
 * An object is an orphan iff the first segment of its key (the file id) matches no
 * `files` row *in any state*. The lookup deliberately ignores `deletedAt`, so trashed
 * rows still protect their objects, and it covers pending-upload rows (whose `s3Uri`
 * is a `pending:` marker rather than a key) for free — which is why this keys off the
 * id rather than matching `s3Uri` strings.
 *
 * Returns the number of objects deleted. Best-effort: a failed delete never throws.
 */
export async function reconcileOrphanObjects(
  db: AppDb,
  storage: StorageClient,
  options: { prefix: string; graceMs?: number; limit?: number }
): Promise<number> {
  const graceMs = options.graceMs ?? ORPHAN_GRACE_MS;
  const cutoff = Date.now() - graceMs;

  const page = await storage.from(buckets.drive).list({ prefix: options.prefix, limit: options.limit ?? ORPHAN_SWEEP_LIMIT });

  const candidates = page.files
    .filter((object) => object.uploadedAt.getTime() < cutoff)
    .map((object) => ({ path: object.path, fileId: fileIdOf(object.path) }))
    .filter((entry): entry is { path: string; fileId: string } => entry.fileId !== null);
  if (candidates.length === 0) return 0;

  const ids = [...new Set(candidates.map((entry) => entry.fileId))];
  const rows = await db.select({ id: files.id }).from(files).where(inArray(files.id, ids));
  const referenced = new Set(rows.map((row) => row.id));

  const orphanPaths = candidates.filter((entry) => !referenced.has(entry.fileId)).map((entry) => entry.path);
  if (orphanPaths.length === 0) return 0;

  try {
    await storage.from(buckets.drive).delete(orphanPaths);
  } catch {
    // Best-effort: the leak simply persists until a later sweep.
    return 0;
  }
  return orphanPaths.length;
}

/**
 * Opportunistic, sampled reconcile of leaked drive objects — orphans left behind when
 * `hardPurgeSubtree`'s best-effort R2 delete fails after the DB rows are committed, or
 * when a worker dies between an R2 put and its row insert.
 *
 * Instead of persisting a list cursor, each sweep picks one random character from the
 * nanoid alphabet and scans only that slice of the bucket. Successive sweeps rotate
 * through the slices, so coverage is eventual — the right trade for a storage leak, and
 * it keeps each sweep's work bounded. Mirrors `maybePurgeStaleTrash`; no cron needed.
 */
export async function maybeReconcileOrphanObjects(db: AppDb, storage: StorageClient): Promise<void> {
  if (Math.random() > ORPHAN_SWEEP_SAMPLE_RATE) return;
  const prefix = ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  try {
    await reconcileOrphanObjects(db, storage, { prefix });
  } catch {
    // Never let a reconcile failure surface on the request that triggered it.
  }
}
