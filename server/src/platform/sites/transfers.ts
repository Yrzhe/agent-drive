import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { files } from "../../defs/db_schema";
import { ApiError, withErrorHandling } from "../../lib/errors";
import { readPendingUploadObjectKey } from "../../lib/pending-marker";
import { checkAccessGate } from "../../lib/access";
import { uploadParts, uploadSessions } from "./schema";
import { sitesPartSize, verifyTransfer } from "./storage";
import type { SitesEnv } from "./types";

export const transferRoutes = new Hono<SitesEnv>();
function uploadError(error: unknown): unknown {
  return error instanceof Error && /FixedLengthStream/u.test(error.message)
    ? new ApiError(400, "size_mismatch", "Upload body has the wrong number of bytes") : error;
}
function uploadStream(request: Request, expected: number): { body: ReadableStream<Uint8Array> | Uint8Array; finished: Promise<void> } {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) !== expected) throw new ApiError(400, "size_mismatch", "Upload chunk differs from its declared size");
  if (!request.body) {
    if (expected !== 0) throw new ApiError(400, "size_mismatch", "Upload body is required");
    return { body: new Uint8Array(), finished: Promise.resolve() };
  }
  const FixedLength = (globalThis as unknown as { FixedLengthStream: typeof import("@cloudflare/workers-types").FixedLengthStream }).FixedLengthStream;
  const stream = new FixedLength(expected) as unknown as TransformStream<Uint8Array, Uint8Array>;
  const finished = request.body.pipeTo(stream.writable).catch(() => { throw new ApiError(400, "size_mismatch", "Upload body has the wrong number of bytes"); });
  // Observe immediately even if R2 rejects before reading the stream.
  void finished.catch(() => {});
  return { body: stream.readable, finished };
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
  if (!file || file.deletedAt || file.ownerId !== session.ownerId || (session.purpose !== "version" && readPendingUploadObjectKey(file.s3Uri) !== grant.key)) {
    throw new ApiError(409, "upload_not_pending", "Upload is no longer pending");
  }
  const denial = await checkAccessGate(db, { id: session.ownerId, email: null });
  if (denial) throw new ApiError(403, denial.code, denial.message);
  const partSize = sitesPartSize(session.expectedSize);
  if (c.req.method === "PUT") {
    if (session.state === "complete" || session.state === "aborted") throw new ApiError(409, "upload_finished", "Upload capability has already been consumed");
    const partQuery = c.req.query("part");
    if (partQuery === undefined) {
      if (session.state !== "pending") throw new ApiError(409, "multipart_started", "Upload has already started as multipart");
      if (session.expectedSize > partSize) throw new ApiError(413, "multipart_required", "Use start, numbered parts and complete for large uploads");
      const claimed = await db.update(uploadSessions).set({ state: "writing" }).where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, "pending"))).returning();
      if (!claimed.length) throw new ApiError(409, "upload_in_progress", "Upload is already in progress");
      try {
        const stream = uploadStream(c.req.raw, session.expectedSize);
        await Promise.all([c.env.BUCKET.put(grant.key, stream.body as never, { httpMetadata: { contentType: session.contentType } }), stream.finished]);
        await db.update(uploadSessions).set({ state: "complete" }).where(eq(uploadSessions.id, session.id));
      } catch (error) {
        await db.update(uploadSessions).set({ state: "pending" }).where(eq(uploadSessions.id, session.id));
        throw uploadError(error);
      }
      return c.json({ uploaded: true });
    }
    const partNumber = Number(partQuery);
    const partCount = Math.ceil(session.expectedSize / partSize);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount || session.state !== "multipart" || !session.uploadId) {
      throw new ApiError(400, "invalid_part", "Multipart session or part number is invalid");
    }
    const expected = Math.min(partSize, session.expectedSize - (partNumber - 1) * partSize);
    const claimed = await db.update(uploadSessions).set({ state: "uploading" }).where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.state, "multipart"))).returning();
    if (!claimed.length) throw new ApiError(409, "upload_in_progress", "Another part or completion is in progress");
    try {
      const stream = uploadStream(c.req.raw, expected);
      const [part] = await Promise.all([c.env.BUCKET.resumeMultipartUpload(grant.key, session.uploadId).uploadPart(partNumber, stream.body as never), stream.finished]);
      await db.insert(uploadParts).values({ sessionId: session.id, partNumber, etag: part.etag, size: expected })
        .onConflictDoUpdate({ target: [uploadParts.sessionId, uploadParts.partNumber], set: { etag: part.etag, size: expected } });
      return c.json({ partNumber, etag: part.etag });
    } catch (error) {
      throw uploadError(error);
    } finally {
      await db.update(uploadSessions).set({ state: "multipart" }).where(eq(uploadSessions.id, session.id));
    }
  }
  if (c.req.method !== "POST") return c.json({ error: "method_not_allowed" }, 405);
  const body = await c.req.json<{ action?: string }>();
  if (body.action === "start") {
    if (session.state === "multipart" && session.uploadId) return c.json({ started: true, partSize });
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
    return c.json({ started: true, partSize });
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
    const count = Math.ceil(session.expectedSize / partSize);
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
