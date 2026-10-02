import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getContext } from "hono/context-storage";
import { nanoid } from "nanoid";
import { files } from "../../defs/db_schema";
import { ApiError, withErrorHandling } from "../../lib/errors";
import { toFileObject } from "../../lib/files";
import { logEvent, getRequestActor } from "../../lib/activity";
import { checkFileSize, checkTotalQuota } from "../../lib/quota";
import { assertRestPathAllowed } from "../../lib/rest-scopes";
import { requireDualAuth } from "../../middleware/auth";
import { requireActiveAccess } from "../../middleware/access-gate";
import type { AppEnv } from "../../types";
import type { Context } from "hono";
import type { SitesEnv } from "./types";
import { uploadSessions } from "./schema";
import { signTransfer, sitesPartSize, sitesUploadTtl, TRANSFER_PATH } from "./storage";
import { createVersions } from "./versions";

export const versionRoutes = new Hono<AppEnv>();
versionRoutes.use("/:id/versions", requireDualAuth, requireActiveAccess);
versionRoutes.use("/:id/versions/*", requireDualAuth, requireActiveAccess);
async function context(c: Context<AppEnv>) {
  const site = getContext<SitesEnv>();
  const { db } = site.get("platform");
  const ownerId = c.get("ownerId");
  if (!ownerId) throw new ApiError(401, "unauthorized", "User identity required");
  const [file] = await db.select().from(files).where(and(eq(files.id, c.req.param("id")!), eq(files.ownerId, ownerId), eq(files.isFolder, 0), isNull(files.deletedAt))).limit(1);
  if (!file) throw new ApiError(404, "file_not_found", "File not found");
  assertRestPathAllowed(c, file.path);
  return { site, db, ownerId, file, versions: createVersions(db, site.env.DB, site.env.BUCKET) };
}
versionRoutes.get("/:id/versions", withErrorHandling(async (c) => {
  const { file, versions } = await context(c as Context<AppEnv>);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50));
  const offset = Math.max(0, Math.floor(Number(c.req.query("offset")) || 0));
  const rows = await versions.list(file, Math.floor(limit), offset);
  return c.json({ fileId: file.id, versions: rows.map(({ s3Uri, ownerId: _owner, ...row }) => ({ ...row, current: s3Uri === file.s3Uri })), limit, offset });
}));
versionRoutes.get("/:id/versions/:versionId/download", withErrorHandling(async (c) => {
  const { site, file, versions } = await context(c as Context<AppEnv>);
  const version = await versions.find(file, c.req.param("versionId")!);
  const { storage } = site.get("platform");
  const grant = await storage.from({ bucket_name: "drive", description: "Drive" }).createPresignedGetUrl(encodeURIComponent(versions.keyFor(version.s3Uri)), 300);
  return c.json({ versionId: version.id, name: version.name, ...grant });
}));
versionRoutes.post("/:id/versions/:versionId/restore", withErrorHandling(async (c) => {
  const { db, file, versions } = await context(c as Context<AppEnv>);
  const version = await versions.find(file, c.req.param("versionId")!);
  const saved = await versions.commit(file, version.s3Uri, version.size, version.contentType);
  await logEvent(db, { ownerId: file.ownerId, eventType: "file.version_restored", targetType: "file", targetId: file.id, targetPath: file.path, actor: await getRequestActor(), metadata: { versionId: version.id } });
  return c.json({ file: toFileObject(saved), versionId: version.id });
}));
versionRoutes.post("/:id/versions/upload", withErrorHandling(async (c) => {
  const { site, db, ownerId, file, versions } = await context(c as Context<AppEnv>);
  await versions.record(file);
  const body = await c.req.json<{ size?: number; contentType?: string }>();
  const size = body.size;
  if (!Number.isSafeInteger(size) || size! < 0) throw new ApiError(400, "validation_error", "size must be a non-negative integer");
  for (const check of [await checkFileSize(size!), await checkTotalQuota(db, size!)]) {
    if (!check.ok) throw new ApiError(413, check.code, check.message);
  }
  const contentType = typeof body.contentType === "string" && body.contentType.trim() ? body.contentType.trim() : "application/octet-stream";
  const id = nanoid();
  const key = `${file.id}/versions/${nanoid()}/${encodeURIComponent(file.name)}`;
  const expiresAt = Date.now() + sitesUploadTtl(size!) * 1000;
  const token = await signTransfer({ operation: "upload", key, expires: expiresAt, nonce: id }, site.env.AGENT_TOKEN);
  await db.insert(uploadSessions).values({ id, fileId: file.id, ownerId, objectKey: key, expectedSize: size!, contentType,
    expiresAt, purpose: "version", baseUri: file.s3Uri, baseUpdatedAt: file.updatedAt });
  const origin = (site.env.ALLOWED_ORIGIN || new URL(c.req.url).origin).replace(/\/+$/u, "");
  return c.json({ fileId: file.id, sessionId: id, uploadUrl: `${origin}${TRANSFER_PATH}?token=${encodeURIComponent(token)}`,
    expiresAt: new Date(expiresAt).toISOString(), requiredHeaders: { "content-type": contentType }, multipart: { partSize: sitesPartSize(size!) } });
}));
versionRoutes.post("/:id/versions/complete", withErrorHandling(async (c) => {
  const { site, db, ownerId, file, versions } = await context(c as Context<AppEnv>);
  const body = await c.req.json<{ sessionId?: string }>();
  const [session] = await db.select().from(uploadSessions).where(and(eq(uploadSessions.id, body.sessionId || ""), eq(uploadSessions.fileId, file.id), eq(uploadSessions.ownerId, ownerId), eq(uploadSessions.purpose, "version"))).limit(1);
  if (!session || session.expiresAt <= Date.now()) throw new ApiError(404, "upload_not_found", "Version upload expired or not found");
  const uri = `s3://drive/${session.objectKey}`;
  if (session.state === "committed") return c.json({ file: toFileObject(file) });
  if (session.state !== "complete") throw new ApiError(409, "upload_pending", "Finish uploading all bytes first");
  const object = await site.env.BUCKET.head(session.objectKey);
  if (!object || object.size !== session.expectedSize) throw new ApiError(409, "size_mismatch", "Uploaded size differs from the declared size");
  const quota = await checkTotalQuota(db, object.size);
  if (!quota.ok) throw new ApiError(413, quota.code, quota.message);
  if (file.s3Uri !== session.baseUri || file.updatedAt !== session.baseUpdatedAt) throw new ApiError(409, "version_conflict", "File changed since this upload started. Upload a new version after reloading.");
  const saved = await versions.commit(file, uri, object.size, session.contentType);
  await db.update(uploadSessions).set({ state: "committed" }).where(eq(uploadSessions.id, session.id));
  await logEvent(db, { ownerId, eventType: "file.version_created", targetType: "file", targetId: file.id, targetPath: file.path, actor: await getRequestActor(), metadata: { size: object.size } });
  return c.json({ file: toFileObject(saved) });
}));
