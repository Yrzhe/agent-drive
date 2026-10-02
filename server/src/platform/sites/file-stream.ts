import type { R2Bucket, R2MultipartUpload, R2UploadedPart } from "@cloudflare/workers-types";
import { ApiError } from "../../lib/errors";
import { SITES_PART_BYTES, sitesPartSize } from "./storage";

export async function storeFileStream(bucket: R2Bucket, key: string, body: ReadableStream<Uint8Array>, contentType: string,
  expectedSize: number | undefined, validateSize: (size: number) => Promise<void>): Promise<number> {
  const partSize = expectedSize === undefined ? SITES_PART_BYTES : sitesPartSize(expectedSize);
  const reader = body.getReader();
  const parts: R2UploadedPart[] = [];
  let upload: R2MultipartUpload | undefined;
  let buffer = new Uint8Array(partSize);
  let filled = 0;
  let total = 0;
  let complete = false;
  async function flush() {
    await validateSize(total);
    if (parts.length >= 10000) throw new ApiError(413, "file_too_large", "Attachment exceeds the multipart part-count limit");
    upload ??= await bucket.createMultipartUpload(key, { httpMetadata: { contentType } });
    parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled) as never));
    filled = 0;
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      let offset = 0;
      while (offset < next.value.byteLength) {
        const count = Math.min(buffer.byteLength - filled, next.value.byteLength - offset);
        buffer.set(next.value.subarray(offset, offset + count), filled);
        filled += count;
        total += count;
        offset += count;
        if (expectedSize !== undefined && total > expectedSize) throw new ApiError(400, "size_mismatch", "Attachment bytes exceed its declared download size");
        if (filled === buffer.byteLength) await flush();
      }
    }
    if (expectedSize !== undefined && total !== expectedSize) throw new ApiError(400, "size_mismatch", "Attachment download ended before all bytes arrived");
    await validateSize(total);
    if (filled) await flush();
    if (upload) await upload.complete(parts);
    else await bucket.put(key, new Uint8Array(), { httpMetadata: { contentType } });
    complete = true;
    return total;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "attachment_transfer_failed", "Attachment transfer did not complete; pass a fresh attachment and retry");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    if (!complete && upload) await upload.abort().catch(() => {});
  }
}
