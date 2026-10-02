import { and, eq, lt, isNull } from "drizzle-orm";
import { files, shares } from "../../defs/db_schema";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { AppDb } from "../../types";
import { fileVersions, shareVersions, uploadParts, uploadSessions } from "./schema";

/** Bounded, retryable cleanup of expired upload capabilities and R2 multipart state. */
export async function cleanupExpiredUploads(db: AppDb, bucket: R2Bucket): Promise<void> {
  const rows = await db.select().from(uploadSessions).where(lt(uploadSessions.expiresAt, Date.now() - 60_000)).limit(50);
  for (const row of rows) {
    try {
      // Expired grants cannot start new operations; the minute grace allows an
      // already-running bounded part to finish. Preserve state until cleanup succeeds.
      if (row.uploadId && row.state !== "complete" && row.state !== "committed" && row.state !== "aborted") {
        await bucket.resumeMultipartUpload(row.objectKey, row.uploadId).abort();
      }
      if (row.purpose === "version") {
        const uri = `s3://drive/${row.objectKey}`;
        const [current] = await db.select({ id: files.id }).from(files).where(eq(files.s3Uri, uri)).limit(1);
        const [retained] = await db.select({ id: fileVersions.id }).from(fileVersions).where(eq(fileVersions.s3Uri, uri)).limit(1);
        if (!current && !retained) await bucket.delete(row.objectKey);
      }
      await db.batch([
        db.delete(uploadParts).where(eq(uploadParts.sessionId, row.id)),
        db.delete(uploadSessions).where(and(eq(uploadSessions.id, row.id), lt(uploadSessions.expiresAt, Date.now() - 60_000))),
      ]);
    } catch {
      // Preserve the session and upload id for a later cleanup attempt.
    }
  }
  // Purged files have no readable versions. Reap at most 20 objects per request;
  // retain metadata on an R2 failure so the next sampled cleanup can retry.
  const orphaned = await db.select({ version: fileVersions }).from(fileVersions).leftJoin(files, eq(files.id, fileVersions.fileId)).where(isNull(files.id)).limit(20);
  for (const { version } of orphaned) {
    try {
      if (version.s3Uri.startsWith("s3://drive/")) await bucket.delete(version.s3Uri.slice(11));
      await db.batch([db.delete(shareVersions).where(eq(shareVersions.versionId, version.id)), db.delete(fileVersions).where(eq(fileVersions.id, version.id))]);
    } catch { /* retain for retry */ }
  }
  const orphanedPins = await db.select({ id: shareVersions.shareId }).from(shareVersions).leftJoin(shares, eq(shares.id, shareVersions.shareId)).where(isNull(shares.id)).limit(20);
  for (const row of orphanedPins) await db.delete(shareVersions).where(eq(shareVersions.shareId, row.id));
}
