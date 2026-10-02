import { describe, expect, it } from "vitest";
import type { R2Bucket } from "@cloudflare/workers-types";
import { ApiError } from "../../lib/errors";
import { storeFileStream } from "./file-stream";

function fixture() {
  const state = { parts: 0, aborted: false, completed: false };
  const bucket = { async createMultipartUpload() { return {
    async uploadPart(partNumber: number) { state.parts++; return { partNumber, etag: `etag-${partNumber}` }; },
    async abort() { state.aborted = true; },
    async complete() { state.completed = true; },
  }; }, async put() { state.completed = true; } } as unknown as R2Bucket;
  return { bucket, state };
}
function source(chunks: number[], fail = false) {
  return new ReadableStream<Uint8Array>({ pull(controller) {
    const length = chunks.shift();
    if (length !== undefined) controller.enqueue(new Uint8Array(length));
    else if (fail) controller.error(new Error("signed-source-secret"));
    else controller.close();
  } });
}
const part = 8 * 1024 * 1024;
describe("attachment stream failure cleanup", () => {
  it("aborts stored parts when a declared-length download is truncated", async () => {
    const { bucket, state } = fixture();
    await expect(storeFileStream(bucket, "key", source([part]), "application/octet-stream", part + 1, async () => {})).rejects.toThrow("before all bytes");
    expect(state).toEqual({ parts: 1, aborted: true, completed: false });
  });
  it("aborts stored parts on a source connection error without leaking the source", async () => {
    const { bucket, state } = fixture();
    await expect(storeFileStream(bucket, "key", source([part], true), "application/octet-stream", undefined, async () => {})).rejects.toThrow("Attachment transfer did not complete");
    expect(state).toEqual({ parts: 1, aborted: true, completed: false });
  });
  it("checks actual-byte quota after each part and aborts on a breach", async () => {
    const { bucket, state } = fixture();
    await expect(storeFileStream(bucket, "key", source([part, 1]), "application/octet-stream", undefined, async size => {
      if (size > part) throw new ApiError(413, "quota_exceeded", "Storage quota exceeded");
    })).rejects.toThrow("Storage quota exceeded");
    expect(state).toEqual({ parts: 1, aborted: true, completed: false });
  });
  it("rejects download bytes larger than Content-Length", async () => {
    const { bucket, state } = fixture();
    await expect(storeFileStream(bucket, "key", source([2]), "application/octet-stream", 1, async () => {})).rejects.toThrow("exceed its declared");
    expect(state.completed).toBe(false);
  });
});
