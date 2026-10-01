import { and, eq, lt } from "drizzle-orm";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { AppDb } from "../../types";
import { uploadParts, uploadSessions } from "./schema";

/** Bounded, retryable cleanup of expired upload capabilities and R2 multipart state. */
export async function cleanupExpiredUploads(db: AppDb, bucket: R2Bucket): Promise<void> {
  const rows = await db.select().from(uploadSessions).where(lt(uploadSessions.expiresAt, Date.now() - 60_000)).limit(50);
  for (const row of rows) {
    try {
      // Expired grants cannot start new operations; the minute grace allows an
      // already-running bounded part to finish. Preserve state until cleanup succeeds.
      if (row.uploadId && row.state !== "complete" && row.state !== "aborted") {
        await bucket.resumeMultipartUpload(row.objectKey, row.uploadId).abort();
      }
      await db.batch([
        db.delete(uploadParts).where(eq(uploadParts.sessionId, row.id)),
        db.delete(uploadSessions).where(and(eq(uploadSessions.id, row.id), lt(uploadSessions.expiresAt, Date.now() - 60_000))),
      ]);
    } catch {
      // Preserve the session and upload id for a later cleanup attempt.
    }
  }
}
