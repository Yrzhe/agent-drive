import { getPlatform } from "@platform";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { buckets, files } from "@defs";
import { ApiError } from "./errors";
import { ensureFolderChain, isPathUniqueConflict, nowIso, toFileObject } from "./files";
import { getRequestActor, logEvent } from "./activity";
import { driveObjectKey } from "./object-keys";
import { normalizeName, normalizePath, parentOfPath } from "./paths";
import { checkFileSize, checkTotalQuota } from "./quota";

export interface ChatGptFile {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

// File parameters supply temporary, authorized URLs. This is not a general URL
// importer: never fetch arbitrary hosts, credentials, local addresses or ports.
export function chatGptDownloadUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 16384) throw new ApiError(400, "invalid_file_source", "A ChatGPT attachment download URL is required");
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, "invalid_file_source", "A valid ChatGPT attachment download URL is required"); }
  const host = url.hostname.toLowerCase();
  const allowed = host === "oaiusercontent.com" || host.endsWith(".oaiusercontent.com") || host === "oaidalleapiprodscus.blob.core.windows.net";
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || !allowed) {
    throw new ApiError(400, "invalid_file_source", "Use the temporary HTTPS attachment URL supplied by ChatGPT, not a local path, file ID alone or arbitrary URL");
  }
  return url;
}

export async function fetchChatGptFile(file: ChatGptFile, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Response> {
  let url = chatGptDownloadUrl(file.download_url);
  for (let hop = 0; hop <= 3; hop++) {
    let response: Response;
    try { response = await fetcher(url, { redirect: "manual", signal, headers: { "Accept-Encoding": "identity" } }); }
    catch { throw new ApiError(502, "attachment_unreachable", "Unable to download the ChatGPT attachment; request a fresh file parameter and retry"); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || hop === 3) throw new ApiError(502, "attachment_redirect_failed", "Attachment download redirected too many times");
      url = chatGptDownloadUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new ApiError(502, "attachment_download_failed", "The attachment URL is unavailable or expired; pass the attachment again to obtain a fresh download URL");
    }
    return response;
  }
  throw new ApiError(502, "attachment_redirect_failed", "Attachment download failed");
}

export async function uploadChatGptFile(pathInput: string, file: ChatGptFile, ownerId: string, assertPathAllowed: (path: string) => void) {
  const platform = await getPlatform();
  if (!platform.storeFileStream) throw new ApiError(400, "unsupported_platform", "ChatGPT attachment ingestion is available on the native Sites deployment");
  if (!pathInput.startsWith("/")) throw new ApiError(400, "invalid_params", "path must be an absolute file path");
  const path = normalizePath(pathInput);
  if (path === "/") throw new ApiError(400, "invalid_params", "path must include a filename");
  assertPathAllowed(path);
  const name = normalizeName(path.slice(path.lastIndexOf("/") + 1));
  const parentPath = parentOfPath(path);
  if (!file || typeof file !== "object" || typeof file.file_id !== "string" || !file.file_id.trim() || file.file_id.length > 512) {
    throw new ApiError(400, "invalid_params", "Pass the actual ChatGPT file parameter with file_id and download_url; a filename or sandbox path is not an attachment");
  }
  chatGptDownloadUrl(file.download_url);
  const { db, storage } = platform;
  const [conflict] = await db.select({ id: files.id }).from(files).where(and(eq(files.path, path), eq(files.ownerId, ownerId))).limit(1);
  if (conflict) throw new ApiError(409, "path_conflict", "Path already exists; choose another filename or remove the unfinished upload first");
  const validateSize = async (size: number) => {
    for (const check of [await checkFileSize(size), await checkTotalQuota(db, size)]) {
      if (!check.ok) throw new ApiError(413, check.code, check.message);
    }
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  const id = nanoid();
  const key = driveObjectKey(id, name);
  let committed = false;
  let source: Response | undefined;
  try {
    source = await fetchChatGptFile(file, controller.signal);
    const header = source.headers.get("content-length");
    const expectedSize = header && /^\d+$/u.test(header) && (!source.headers.get("content-encoding") || source.headers.get("content-encoding") === "identity") ? Number(header) : undefined;
    if (expectedSize !== undefined && !Number.isSafeInteger(expectedSize)) throw new ApiError(413, "file_too_large", "Attachment size is invalid");
    await validateSize(expectedSize ?? 0);
    const suppliedType = typeof file.mime_type === "string" ? file.mime_type : "";
    const contentType = (suppliedType || source.headers.get("content-type") || "application/octet-stream").split(";")[0]!.trim();
    if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(contentType)) throw new ApiError(400, "invalid_params", "Attachment MIME type is invalid");
    const size = await platform.storeFileStream(key, source.body!, contentType, expectedSize, validateSize);
    await validateSize(size);
    await ensureFolderChain(db, parentPath, ownerId);
    const timestamp = nowIso();
    let row;
    try {
      [row] = await db.insert(files).values({ id, name, path, parentPath, ownerId, size, contentType,
        isFolder: 0, s3Uri: storage.createS3Uri(buckets.drive, key), createdAt: timestamp, updatedAt: timestamp }).returning();
    } catch (error) {
      if (isPathUniqueConflict(error)) throw new ApiError(409, "path_conflict", "A file was created at this path during the import; choose another filename");
      throw error;
    }
    if (!row) throw new ApiError(500, "attachment_commit_failed", "Attachment could not be saved");
    committed = true;
    await logEvent(db, { ownerId, eventType: "file.uploaded", targetType: "file", targetId: id, targetPath: path,
      actor: await getRequestActor(), metadata: { size, contentType, source: "chatgpt_attachment" } });
    return { file: toFileObject(row), uploadStatus: "complete" as const };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (source?.body && !source.body.locked) await source.body.cancel().catch(() => {});
    if (!committed) await storage.from(buckets.drive).delete(key).catch(() => {});
  }
}
