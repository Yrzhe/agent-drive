import { DriveApiError } from "./api-client";
import type { UploadTicket } from "../types/drive";

export async function uploadBlob(ticket: UploadTicket, file: Blob, progress: (percent: number) => void): Promise<void> {
  const partSize = ticket.multipart?.partSize;
  const control = async (action: string) => {
    const response = await fetch(ticket.uploadUrl, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
    if (!response.ok) throw new DriveApiError(`Upload ${action} failed (${response.status})`, response.status, "UPLOAD_FAILED");
  };
  const put = (blob: Blob, url: string, offset: number) => new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [key, value] of Object.entries(ticket.requiredHeaders)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(Math.round((offset + event.loaded) / Math.max(1, file.size) * 100)); };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new DriveApiError(`Upload failed (${xhr.status})`, xhr.status, "UPLOAD_FAILED"));
    xhr.onerror = () => reject(new DriveApiError("Upload network error", 0, "UPLOAD_FAILED"));
    xhr.send(blob);
  });
  if (!partSize || file.size <= partSize) { await put(file, ticket.uploadUrl, 0); return; }
  if (!Number.isSafeInteger(partSize) || partSize < 5 * 1024 * 1024 || partSize > 64 * 1024 * 1024) throw new DriveApiError("Invalid upload chunk size", 500, "INVALID_UPLOAD_TICKET");
  await control("start");
  try {
    for (let offset = 0, part = 1; offset < file.size; offset += partSize, part++) {
      const url = new URL(ticket.uploadUrl);
      url.searchParams.set("part", String(part));
      await put(file.slice(offset, offset + partSize), url.toString(), offset);
    }
    await control("complete");
  } catch (error) {
    await control("abort").catch(() => {});
    throw error;
  }
}
