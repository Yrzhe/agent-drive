import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { files } from "../../defs/db_schema";
import { ApiError } from "../../lib/errors";
import { nowIso } from "../../lib/files";
import type { AppDb, FileRow } from "../../types";
import type { PlatformRuntime } from "../types";
import { fileVersions, shareVersions } from "./schema";

export function createVersions(db: AppDb, raw: D1Database, bucket: R2Bucket) {
  const keyFor = (uri: string) => {
    if (!uri.startsWith("s3://drive/")) throw new ApiError(409, "upload_pending", "File has no completed object");
    return uri.slice("s3://drive/".length);
  };
  async function record(file: FileRow) {
    if (!file.ownerId || !file.s3Uri || file.isFolder || file.deletedAt) throw new ApiError(409, "upload_pending", "A completed file is required");
    keyFor(file.s3Uri);
    await db.insert(fileVersions).values({ id: nanoid(), fileId: file.id, ownerId: file.ownerId, s3Uri: file.s3Uri,
      name: file.name, size: file.size, contentType: file.contentType, createdAt: file.updatedAt }).onConflictDoNothing();
    const [version] = await db.select().from(fileVersions).where(and(eq(fileVersions.fileId, file.id), eq(fileVersions.s3Uri, file.s3Uri))).limit(1);
    if (!version) throw new Error("Version record unavailable");
    return version;
  }
  async function find(file: FileRow, versionId: string) {
    const [version] = await db.select().from(fileVersions).where(and(eq(fileVersions.id, versionId), eq(fileVersions.fileId, file.id), eq(fileVersions.ownerId, file.ownerId!))).limit(1);
    if (!version) throw new ApiError(404, "version_not_found", "File version not found");
    return version;
  }
  async function commit(existing: FileRow, uri: string, size: number, contentType: string | null, name = existing.name) {
    await record(existing);
    const timestamp = nowIso();
    const id = nanoid();
    // Atomic compare-and-swap: a concurrent edit cannot silently replace a newer pointer.
    // The immutable R2 object is uploaded first; a failed CAS never changes the file.
    const results = await raw.batch([
      raw.prepare("UPDATE files SET s3_uri=?, size=?, content_type=?, updated_at=? WHERE id=? AND s3_uri=? AND updated_at=? AND deleted_at IS NULL")
        .bind(uri, size, contentType, timestamp, existing.id, existing.s3Uri, existing.updatedAt),
      raw.prepare("INSERT OR IGNORE INTO sites_file_versions(id,file_id,owner_id,s3_uri,name,size,content_type,created_at) SELECT ?,id,owner_id,?,?,size,content_type,? FROM files WHERE id=? AND s3_uri=? AND updated_at=?")
        .bind(id, uri, name, timestamp, existing.id, uri, timestamp),
    ]);
    if (!results[0]?.meta.changes) throw new ApiError(409, "version_conflict", "File changed during this operation. Reload its versions and retry.");
    const [saved] = await db.select().from(files).where(eq(files.id, existing.id)).limit(1);
    if (!saved) throw new ApiError(404, "file_not_found", "File no longer exists");
    return saved;
  }
  const service: NonNullable<PlatformRuntime["versioning"]> = {
    async extraUsageBytes() {
      // Count retained history in addition to the active file pointers, without
      // charging twice for a current version or a pointer restored to old bytes.
      const [row] = await db.select({ total: sql<number>`coalesce(sum(${fileVersions.size}), 0)` }).from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId)).where(sql`${fileVersions.s3Uri} != ${files.s3Uri} OR ${files.deletedAt} IS NOT NULL`);
      return Number(row?.total ?? 0);
    },
    async writeText(existing, values, bytes) {
      const key = `${values.id}/versions/${nanoid()}/${encodeURIComponent(values.name)}`;
      const uri = `s3://drive/${key}`;
      await bucket.put(key, bytes as never, { httpMetadata: { contentType: values.contentType || "text/plain" } });
      try {
        if (existing) return await commit(existing, uri, bytes.byteLength, values.contentType);
        const [saved] = await db.insert(files).values({ ...values, s3Uri: uri }).returning();
        if (!saved) throw new Error("File insert failed");
        await record(saved);
        return saved;
      } catch (error) {
        // Do not erase bytes if DB persistence succeeded but a later step failed.
        const [referenced] = await db.select({ id: files.id }).from(files).where(eq(files.s3Uri, uri)).limit(1);
        if (!referenced) await bucket.delete(key).catch(() => {});
        throw error;
      }
    },
    async pinShare(shareId, file, versionId) {
      const version = versionId ? await find(file, versionId) : await record(file);
      await db.insert(shareVersions).values({ shareId, versionId: version.id });
      return version.id;
    },
    async resolveShare(shareId, file) {
      const [pinned] = await db.select({ version: fileVersions }).from(shareVersions)
        .leftJoin(fileVersions, eq(fileVersions.id, shareVersions.versionId)).where(eq(shareVersions.shareId, shareId)).limit(1);
      if (!pinned) return file;
      if (!pinned.version) throw new ApiError(404, "version_not_found", "Shared version no longer exists");
      if (pinned.version.fileId !== file.id || pinned.version.ownerId !== file.ownerId) throw new ApiError(404, "version_not_found", "Shared version no longer exists");
      return { ...file, name: pinned.version.name, size: pinned.version.size, contentType: pinned.version.contentType, s3Uri: pinned.version.s3Uri, updatedAt: pinned.version.createdAt };
    },
    async shareDetails(ids) {
      const result = new Map<string, { shareMode: "fixed"; versionId: string }>();
      // Stay under D1's 100 bound-parameter limit even on a 500-share page.
      for (let offset = 0; offset < ids.length; offset += 90) {
        const rows = await db.select().from(shareVersions).where(inArray(shareVersions.shareId, ids.slice(offset, offset + 90)));
        for (const row of rows) result.set(row.shareId, { shareMode: "fixed", versionId: row.versionId });
      }
      return result;
    },
  };
  return { ...service, record, find, commit, keyFor,
    async list(file: FileRow, limit: number, offset: number) {
      await record(file);
      return db.select().from(fileVersions).where(eq(fileVersions.fileId, file.id)).orderBy(desc(fileVersions.createdAt), desc(fileVersions.id)).limit(limit).offset(offset);
    },
  };
}
