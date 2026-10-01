import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { files } from "../../defs/db_schema";
import { ApiError, withErrorHandling } from "../../lib/errors";
import { readPendingUploadObjectKey } from "../../lib/pending-marker";
import { checkAccessGate } from "../../lib/access";
import { uploadParts, uploadSessions } from "./schema";
import { SITES_PART_BYTES, verifyTransfer } from "./storage";
import type { SitesEnv } from "./types";

export const transferRoutes = new Hono<SitesEnv>();
async function boundedBody(request: Request, maximum: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maximum) throw new ApiError(413, "part_too_large", "Upload must use bounded multipart chunks");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new ApiError(413, "part_too_large", "Upload chunk exceeds its limit"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
transferRoutes.all("/", withErrorHandling(async (untyped) => {
  const c = untyped as unknown as import("hono").Context<SitesEnv>;
  const grant = await verifyTransfer(c.req.query("token"), c.env.AGENT_TOKEN);
  if (!grant) throw new ApiError(401, "invalid_transfer_token", "Transfer link is invalid or expired");
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  if (grant.operation === "read") {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "method_not_allowed" }, 405);
    const rangeHeader = c.req.header("range");
    if (rangeHeader && !/^bytes=(?:\d+-\d*|-\d+)$/u.test(rangeHeader)) throw new ApiError(416, "invalid_range", "A single byte range is required");
    const object = await c.env.BUCKET.get(grant.key, rangeHeader ? { range: c.req.raw.headers as never } : undefined);
    if (!object) throw new ApiError(404, "file_not_found", "File no longer exists");
    const headers = new Headers({ "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    object.writeHttpMetadata(headers as never);
    headers.set("etag", object.httpEtag);
    headers.set("accept-ranges", "bytes");
    const range = rangeHeader ? object.range : undefined;
    const offset = range && "suffix" in range ? Math.max(0, object.size - range.suffix) : range && "offset" in range ? range.offset ?? 0 : 0;
    const length = range && "length" in range ? range.length ?? object.size - offset : object.size - offset;
    headers.set("content-length", String(length));
    if (range) headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    return new Response(c.req.method === "HEAD" ? null : object.body as unknown as ReadableStream, { status: range ? 206 : 200, headers });
  }
  const { db } = c.get("platform");
  const [session] = await db.select().from(uploadSessions).where(eq(uploadSessions.id, grant.nonce)).limit(1);
  if (!session || session.objectKey !== grant.key || session.expiresAt <= Date.now()) throw new ApiError(401, "invalid_transfer_token", "Upload session expired");
  const [file] = await db.select().from(files).where(eq(files.id, session.fileId)).limit(1);
  if (!file || file.deletedAt || file.ownerId !== session.ownerId || readPendingUploadObjectKey(file.s3Uri) !== grant.key) {
    throw new ApiError(409, "upload_not_pending", "Upload is no longer pending");
  }
  const denial = await checkAccessGate(db, { id: session.ownerId, email: null });
  if (denial) throw new ApiError(403, denial.code, denial.message);
  if (c.req.method === "PUT") {
    if (session.state === "complete" || session.state === "aborted") throw new ApiError(409, "upload_finished", "Upload capability has already been consumed");
    const partQuery = c.req.query("part");
    if (partQuery === undefined) {
      if (session.state !== "pending") throw new ApiError(409, "multipart_started", "Upload has already started as multipart");
      if (session.expectedSize > SITES_PART_BYTES) throw new ApiError(413, "multipart_required", "Use start, numbered parts and complete for large uploads");
      const bytes = await boundedBody(c.req.raw, SITES_PART_BYTES);
      if (bytes.byteLength !== session.expectedSize) throw new ApiError(400, "size_mismatch", "Uploaded size differs from the upload ticket");
      const claimed = await db.update(uploadSessions).set({ state: "writing" }).where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, "pending"))).returning();
      if (!claimed.length) throw new ApiError(409, "upload_in_progress", "Upload is already in progress");
      try {
        await c.env.BUCKET.put(grant.key, bytes as never, { httpMetadata: { contentType: session.contentType } });
        await db.update(uploadSessions).set({ state: "complete" }).where(eq(uploadSessions.id, session.id));
      } catch (error) {
        await db.update(uploadSessions).set({ state: "pending" }).where(eq(uploadSessions.id, session.id));
        throw error;
      }
      return c.json({ uploaded: true });
    }
    const partNumber = Number(partQuery);
    const partCount = Math.ceil(session.expectedSize / SITES_PART_BYTES);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount || session.state !== "multipart" || !session.uploadId) {
      throw new ApiError(400, "invalid_part", "Multipart session or part number is invalid");
    }
    const expected = Math.min(SITES_PART_BYTES, session.expectedSize - (partNumber - 1) * SITES_PART_BYTES);
    const bytes = await boundedBody(c.req.raw, expected);
    if (bytes.byteLength !== expected) throw new ApiError(400, "size_mismatch", "Upload part has the wrong length");
    const claimed = await db.update(uploadSessions).set({ state: "uploading" }).where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, "multipart"))).returning();
    if (!claimed.length) throw new ApiError(409, "upload_in_progress", "Another part or completion is in progress");
    try {
      const part = await c.env.BUCKET.resumeMultipartUpload(grant.key, session.uploadId).uploadPart(partNumber, bytes as never);
      await db.insert(uploadParts).values({ sessionId: session.id, partNumber, etag: part.etag, size: bytes.byteLength })
        .onConflictDoUpdate({ target: [uploadParts.sessionId, uploadParts.partNumber], set: { etag: part.etag, size: bytes.byteLength } });
      return c.json({ partNumber, etag: part.etag });
    } finally {
      await db.update(uploadSessions).set({ state: "multipart" }).where(eq(uploadSessions.id, session.id));
    }
  }
  if (c.req.method !== "POST") return c.json({ error: "method_not_allowed" }, 405);
  const body = await c.req.json<{ action?: string }>();
  if (body.action === "start") {
    if (session.state === "multipart" && session.uploadId) return c.json({ started: true, partSize: SITES_PART_BYTES });
    const claimed = await db.update(uploadSessions).set({ state: "starting" }).where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, "pending"))).returning();
    if (!claimed.length) throw new ApiError(409, "upload_in_progress", "Upload cannot be started in its current state");
    let multipart: Awaited<ReturnType<typeof c.env.BUCKET.createMultipartUpload>> | undefined;
    try {
      multipart = await c.env.BUCKET.createMultipartUpload(grant.key, { httpMetadata: { contentType: session.contentType } });
      await db.update(uploadSessions).set({ state: "multipart", uploadId: multipart.uploadId }).where(eq(uploadSessions.id, session.id));
    } catch (error) {
      if (multipart) await multipart.abort().catch(() => {});
      await db.update(uploadSessions).set({ state: "pending" }).where(eq(uploadSessions.id, session.id));
      throw error;
    }
    return c.json({ started: true, partSize: SITES_PART_BYTES });
  }
  if (body.action === "abort") {
    if (session.state === "aborted") return c.json({ aborted: true });
    if (session.state === "complete") throw new ApiError(409, "upload_finished", "Completed upload cannot be aborted");
    if (session.state !== "pending" && session.state !== "multipart") throw new ApiError(409, "upload_in_progress", "Wait for the current operation before aborting");
    const claimed = await db.update(uploadSessions).set({ state: "aborting" }).where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, session.state))).returning();
    if (!claimed.length) throw new ApiError(409, "upload_in_progress", "Upload operation is already in progress");
    try {
      if (session.uploadId) await c.env.BUCKET.resumeMultipartUpload(grant.key, session.uploadId).abort();
      await db.update(uploadSessions).set({ state: "aborted" }).where(eq(uploadSessions.id, session.id));
    } catch (error) {
      await db.update(uploadSessions).set({ state: session.state }).where(eq(uploadSessions.id, session.id));
      throw error;
    }
    return c.json({ aborted: true });
  }
  if (body.action === "complete") {
    if (session.state === "complete") return c.json({ uploaded: true });
    if (session.state !== "multipart" || !session.uploadId) throw new ApiError(409, "multipart_not_started", "Start the upload first");
    const parts = await db.select().from(uploadParts).where(eq(uploadParts.sessionId, session.id)).orderBy(asc(uploadParts.partNumber));
    const count = Math.ceil(session.expectedSize / SITES_PART_BYTES);
    if (parts.length !== count || parts.some((part, index) => part.partNumber !== index + 1) ||
        parts.reduce((total, part) => total + part.size, 0) !== session.expectedSize) throw new ApiError(409, "parts_missing", "All upload parts must be present");
    const claimed = await db.update(uploadSessions).set({ state: "completing" }).where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, "multipart"))).returning();
    if (!claimed.length) throw new ApiError(409, "upload_in_progress", "Multipart completion is already in progress");
    try {
      await c.env.BUCKET.resumeMultipartUpload(grant.key, session.uploadId).complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
      await db.update(uploadSessions).set({ state: "complete" }).where(eq(uploadSessions.id, session.id));
    } catch (error) {
      await db.update(uploadSessions).set({ state: "multipart" }).where(eq(uploadSessions.id, session.id));
      throw error;
    }
    return c.json({ uploaded: true });
  }
  throw new ApiError(400, "invalid_action", "Expected start, complete or abort");
}));
