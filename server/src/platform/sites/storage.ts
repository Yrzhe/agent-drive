import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { R2Bucket } from "@cloudflare/workers-types";
import { files } from "../../defs/db_schema";
import { readPendingUploadDeclaredSize, readPendingUploadObjectKey } from "../../lib/pending-marker";
import type { AppDb } from "../../types";
import type { BucketDef, HttpMetadata, ObjectMetadata, PlatformStorage } from "../types";
import { uploadSessions } from "./schema";

export const SITES_PART_BYTES = 8 * 1024 * 1024;
export const SITES_MAX_PART_BYTES = 64 * 1024 * 1024;
export const SITES_MAX_FILE_BYTES = SITES_MAX_PART_BYTES * 10_000;
export function sitesUploadTtl(size: number, requested = 3600): number {
  // Budget transfer time at 5 MiB/s plus 15 minutes, capped at seven days.
  return Math.min(7 * 24 * 3600, Math.max(requested, 3600, Math.ceil(size / (5 * 1024 * 1024)) + 900));
}
export function sitesPartSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0 || size > SITES_MAX_FILE_BYTES) throw new Error("File exceeds this Sites transport's supported size");
  return Math.max(SITES_PART_BYTES, Math.ceil(size / 10_000 / (1024 * 1024)) * 1024 * 1024);
}
export const TRANSFER_PATH = "/api/public/transfer";
export interface TransferGrant {
  operation: "read" | "upload";
  key: string;
  expires: number;
  nonce: string;
}
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid transfer token");
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signTransfer(grant: TransferGrant, secret: string): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(grant)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(`agent-drive-transfer-v1.${body}`));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}
export async function verifyTransfer(token: string | undefined, secret: string): Promise<TransferGrant | null> {
  try {
    if (!token || token.length > 8192) return null;
    const [body, signature, extra] = token.split(".");
    if (extra || !body || !signature) return null;
    if (!await crypto.subtle.verify("HMAC", await hmacKey(secret), decode(signature).buffer as ArrayBuffer, new TextEncoder().encode(`agent-drive-transfer-v1.${body}`))) return null;
    const grant = JSON.parse(new TextDecoder().decode(decode(body))) as TransferGrant;
    if (!['read', 'upload'].includes(grant.operation) || typeof grant.key !== "string" || !grant.key ||
      typeof grant.nonce !== "string" || !grant.nonce || !Number.isSafeInteger(grant.expires) || grant.expires <= Date.now()) return null;
    return grant;
  } catch { return null; }
}
export function r2Metadata(object: { size: number; httpMetadata?: HttpMetadata }): ObjectMetadata {
  return { size: object.size, ...object.httpMetadata };
}
export function createSitesStorage(db: AppDb, bucket: R2Bucket, origin: string, secret: string, ownerId: () => string | null): PlatformStorage {
  function parse(value: string): { bucket: BucketDef; path: string } | null {
    const match = /^s3:\/\/drive\/(.+)$/su.exec(value);
    return match ? { bucket: { bucket_name: "drive", description: "Agent Drive" }, path: match[1] } : null;
  }
  async function url(operation: TransferGrant['operation'], path: string, ttl: number, nonce: string) {
    const expiresAt = new Date(Date.now() + Math.max(1, Math.min(ttl, operation === "upload" ? 7 * 24 * 3600 : 3600)) * 1000);
    const key = decodeURIComponent(path); // preserve EdgeSpark's once-decoded presign contract
    const token = await signTransfer({ operation, key, expires: expiresAt.getTime(), nonce }, secret);
    return { url: `${origin}${TRANSFER_PATH}?token=${encodeURIComponent(token)}`, expiresAt, key };
  }
  const storage: PlatformStorage = {
    from(definition) {
      if (definition.bucket_name !== "drive") throw new Error("Unknown storage bucket");
      return {
        async put(path, body, options = {}) {
          const bytes = ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : new Uint8Array(body);
          await bucket.put(path, bytes as never, { httpMetadata: options });
        },
        async get(path) {
          const object = await bucket.get(path);
          return object ? { body: await object.arrayBuffer(), metadata: r2Metadata(object) } : null;
        },
        async head(path) { const object = await bucket.head(path); return object ? r2Metadata(object) : null; },
        async list(options = {}) {
          const page = await bucket.list({ ...options, include: ["httpMetadata"] });
          return { files: page.objects.map((object) => ({ path: object.key, size: object.size, uploadedAt: object.uploaded })),
            hasMore: page.truncated, cursor: page.truncated ? page.cursor : undefined, delimitedPrefixes: page.delimitedPrefixes };
        },
        async delete(paths) { await bucket.delete(typeof paths === "string" ? paths : [...paths]); },
        async createPresignedGetUrl(path, ttl = 300) {
          const signed = await url("read", path, ttl, nanoid());
          return { downloadUrl: signed.url, expiresAt: signed.expiresAt };
        },
        async createPresignedPutUrl(path, ttl = 3600, options = {}) {
          const nonce = nanoid();
          const key = decodeURIComponent(path);
          const fileId = key.slice(0, key.indexOf("/"));
          const [file] = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
          const principal = ownerId();
          const expectedSize = readPendingUploadDeclaredSize(file?.s3Uri ?? null);
          if (!principal || file?.ownerId !== principal || file.deletedAt || expectedSize === null ||
              readPendingUploadObjectKey(file.s3Uri) !== key || !Number.isSafeInteger(expectedSize)) {
            throw new Error("Invalid pending upload principal or object key");
          }
          const signed = await url("upload", path, sitesUploadTtl(expectedSize, ttl), nonce);
          await db.insert(uploadSessions).values({ id: nonce, fileId, ownerId: principal, objectKey: signed.key,
            contentType: options.contentType || "application/octet-stream", expectedSize, expiresAt: signed.expiresAt.getTime() });
          return { uploadUrl: signed.url, expiresAt: signed.expiresAt,
            requiredHeaders: { "content-type": options.contentType || "application/octet-stream" }, multipart: { partSize: sitesPartSize(expectedSize) } };
        },
      };
    },
    createS3Uri(definition, path) { return `s3://${definition.bucket_name}/${path}`; },
    isS3Uri(value): value is `s3://${string}/${string}` { return parse(value) !== null; },
    tryParseS3Uri: parse,
    parseS3Uri(value) { const result = parse(value); if (!result) throw new Error("Invalid storage URI"); return result; },
  };
  return storage;
}
