import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { driveObjectKey } from "./object-keys";

import { buckets, contacts, files } from "@defs";

import { signWithIdentity, type Jwk } from "./agent-identity";
import { ensureFolderChain, nowIso, toFileObject } from "./files";
import { joinPath, normalizeName } from "./paths";
import { validateWebhookUrlForDelivery } from "./webhooks";
import type { AppDb, FileObject } from "../types";

export type ContactRow = typeof contacts.$inferSelect;

export const INBOX_ROOT = "/inbox";
export const INBOX_PENDING_ROOT = "/inbox/pending";
export const INBOX_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const INBOX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const MESSAGE_MAX_CHARS = 2000;

export const SIGNATURE_HEADER = "x-agent-signature";

export interface InboxPayload {
  from: string;
  filename: string;
  contentType: string | null;
  contentBase64: string;
  message: string | null;
  sentAt: string;
}

/** Validate the (already signature-verified) inbox body shape and limits. */
export function parseInboxPayload(raw: unknown): InboxPayload {
  if (!raw || typeof raw !== "object") throw new Error("invalid_payload:body must be a JSON object");
  const body = raw as Record<string, unknown>;
  if (typeof body.from !== "string" || !body.from.trim()) throw new Error("invalid_payload:from is required");
  if (typeof body.filename !== "string" || !body.filename.trim()) throw new Error("invalid_payload:filename is required");
  if (typeof body.contentBase64 !== "string" || !body.contentBase64) throw new Error("invalid_payload:contentBase64 is required");
  if (typeof body.sentAt !== "string" || !Number.isFinite(Date.parse(body.sentAt))) {
    throw new Error("invalid_payload:sentAt must be an ISO timestamp");
  }
  const skew = Math.abs(Date.now() - Date.parse(body.sentAt));
  if (skew > INBOX_TIMESTAMP_SKEW_MS) throw new Error("invalid_payload:sentAt outside the accepted window");
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, MESSAGE_MAX_CHARS) : null;
  return {
    from: body.from.trim().replace(/\/+$/u, ""),
    filename: normalizeName(body.filename),
    contentType: typeof body.contentType === "string" && body.contentType.trim() ? body.contentType.trim() : null,
    contentBase64: body.contentBase64,
    message,
    sentAt: body.sentAt,
  };
}

export function decodeInboxContent(contentBase64: string): Uint8Array {
  // Reject by encoded length BEFORE atob so oversized payloads never allocate
  // the decoded string (4/3 expansion + padding).
  if (contentBase64.length > Math.ceil((INBOX_MAX_FILE_BYTES * 4) / 3) + 4) {
    throw new Error(`invalid_payload:content exceeds ${INBOX_MAX_FILE_BYTES} bytes`);
  }
  let binary: string;
  try {
    binary = atob(contentBase64);
  } catch {
    throw new Error("invalid_payload:contentBase64 is not valid base64");
  }
  if (binary.length > INBOX_MAX_FILE_BYTES) {
    throw new Error(`invalid_payload:content exceeds ${INBOX_MAX_FILE_BYTES} bytes`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function inboxTargetFolder(contact: Pick<ContactRow, "name" | "autoRelease">): string {
  const root = contact.autoRelease === 1 ? INBOX_ROOT : INBOX_PENDING_ROOT;
  return joinPath(root, contact.name);
}

export async function getContactByUrl(db: AppDb, url: string): Promise<ContactRow | null> {
  const normalized = url.trim().replace(/\/+$/u, "");
  const [row] = await db.select().from(contacts).where(eq(contacts.url, normalized)).limit(1);
  return row ?? null;
}

export async function getContactByName(db: AppDb, name: string, ownerId: string | null): Promise<ContactRow | null> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.name, name), ownerId ? eq(contacts.ownerId, ownerId) : undefined))
    .limit(1);
  return row ?? null;
}

/** Store an inbox delivery under quarantine (or the released folder). */
export async function storeInboxFile(
  db: AppDb,
  storage: typeof import("edgespark")["storage"],
  contact: ContactRow,
  payload: InboxPayload,
  bytes: Uint8Array
): Promise<{ file: FileObject; folder: string; quarantined: boolean }> {
  // A delivery belongs to whoever owns the receiving contact, not the external peer.
  const ownerId = contact.ownerId ?? null;
  const folder = inboxTargetFolder(contact);
  await ensureFolderChain(db, folder, ownerId);

  let targetPath = joinPath(folder, payload.filename);
  const [occupied] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.path, targetPath), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
    .limit(1);
  if (occupied) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const dot = payload.filename.lastIndexOf(".");
    const stamped = dot > 0
      ? `${payload.filename.slice(0, dot)}-${stamp}${payload.filename.slice(dot)}`
      : `${payload.filename}-${stamp}`;
    targetPath = joinPath(folder, stamped);
  }

  const fileId = nanoid();
  const name = targetPath.split("/").pop() ?? payload.filename;
  const objectPath = driveObjectKey(fileId, name);
  await storage.from(buckets.drive).put(objectPath, bytes, { contentType: payload.contentType ?? "application/octet-stream" });

  const timestamp = nowIso();
  const [row] = await db
    .insert(files)
    .values({
      id: fileId,
      name,
      path: targetPath,
      parentPath: folder,
      isFolder: 0,
      size: bytes.byteLength,
      contentType: payload.contentType,
      s3Uri: storage.createS3Uri(buckets.drive, objectPath),
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerId,
    })
    .returning();

  return { file: toFileObject(row), folder, quarantined: contact.autoRelease !== 1 };
}

export interface SendResult {
  contact: string;
  peerStatus: number;
  peerResponse: unknown;
}

/** Sign and deliver a drive file to a peer contact's inbox endpoint. */
export async function sendFileToContact(
  db: AppDb,
  storage: typeof import("edgespark")["storage"],
  contact: ContactRow,
  filePath: string,
  message: string | null,
  ourOrigin: string
): Promise<SendResult> {
  const [row] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.path, filePath),
        eq(files.isFolder, 0),
        isNull(files.deletedAt),
        contact.ownerId ? eq(files.ownerId, contact.ownerId) : undefined
      )
    )
    .limit(1);
  if (!row) throw new Error("file_not_found");
  if (!row.s3Uri) throw new Error("upload_pending");
  if (row.size > INBOX_MAX_FILE_BYTES) throw new Error(`file_too_large:peer inbox limit is ${INBOX_MAX_FILE_BYTES} bytes`);

  const parsed = storage.tryParseS3Uri(row.s3Uri);
  if (!parsed) throw new Error("storage_error");
  const obj = await storage.from(buckets.drive).get(parsed.path);
  if (!obj) throw new Error("file_not_found");
  const objBody = obj.body as unknown;
  const bytes = objBody instanceof Uint8Array ? objBody : new Uint8Array(objBody as ArrayBuffer);

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const payload: InboxPayload = {
    from: ourOrigin.replace(/\/+$/u, ""),
    filename: row.name,
    contentType: row.contentType,
    contentBase64: btoa(binary),
    message,
    sentAt: nowIso(),
  };
  const bodyText = JSON.stringify(payload);
  const signature = await signWithIdentity(db, new TextEncoder().encode(bodyText));

  const inboxUrl = `${contact.url}/api/public/inbox`;
  const validationError = await validateWebhookUrlForDelivery(inboxUrl);
  if (validationError) throw new Error(`peer_unreachable:${validationError}`);

  const response = await fetch(inboxUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", "X-Agent-Signature": signature },
    body: bodyText,
  });
  const peerResponse = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`peer_rejected:HTTP ${response.status} ${JSON.stringify(peerResponse ?? {})}`.slice(0, 300));
  }
  return { contact: contact.name, peerStatus: response.status, peerResponse };
}

export function toContactObject(row: ContactRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    algorithm: row.algorithm,
    publicKeyJwk: JSON.parse(row.publicKeyJwk) as Jwk,
    autoRelease: row.autoRelease === 1,
    addedAt: row.addedAt,
  };
}
