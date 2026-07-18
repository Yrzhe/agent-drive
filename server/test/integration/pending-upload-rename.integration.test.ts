import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buckets, files } from "../../src/defs";
import { driveObjectKey } from "../../src/lib/object-keys";
import { PENDING_UPLOAD_TTL_MS, reclaimStalePendingUpload } from "../../src/lib/pending-uploads";
import app from "../../src/index";
import {
  jsonHeaders,
  putViaPresignedUrl,
  resetRuntime,
  runtime,
  useBearer,
} from "./edge-runtime";

/**
 * Issue #50: PATCH /v1/files/:id can rename a pending upload row (a supported
 * operation — it's used to clear a restore path-conflict). Before the fix, the
 * object key was always recomputed from the CURRENT row name, so a rename
 * desynced the row from the R2 object the presigned PUT actually landed at:
 * /upload/complete 404s with `upload_not_found`, and pending cleanup deletes
 * the wrong (renamed, never-written) key while the real object leaks.
 *
 * The fix stores the ORIGINAL object key in the `pending:` marker at /upload
 * time and resolves from it everywhere, instead of recomputing from the name.
 */

const SCOPES = ["read:drive", "write:drive", "share:create", "path:/"];

async function startUpload(filename: string, path: string, size: number) {
  const res = await app.request("/api/public/v1/files/upload", {
    method: "POST",
    headers: jsonHeaders(useBearer(SCOPES)),
    body: JSON.stringify({ filename, path, size, contentType: "application/octet-stream" }),
  });
  const text = await res.text();
  return {
    status: res.status,
    detail: text,
    body: (text ? JSON.parse(text) : {}) as { fileId?: string; uploadUrl?: string },
  };
}

async function renameFile(fileId: string, name: string) {
  return app.request(`/api/public/v1/files/${fileId}`, {
    method: "PATCH",
    headers: jsonHeaders(useBearer(SCOPES)),
    body: JSON.stringify({ name }),
  });
}

async function completeUpload(fileId: string, filename: string, path: string) {
  const res = await app.request("/api/public/v1/files/upload/complete", {
    method: "POST",
    headers: jsonHeaders(useBearer(SCOPES)),
    body: JSON.stringify({ fileId, filename, path }),
  });
  const text = await res.text();
  return { status: res.status, detail: text, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

describe("pending upload rename desync (#50)", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("rename-then-complete succeeds and the completed file keeps the ORIGINAL object key", async () => {
    const started = await startUpload("original.bin", "/rn", 5);
    expect(started.detail).toContain("uploadUrl");
    const fileId = started.body.fileId!;
    const originalKey = driveObjectKey(fileId, "original.bin");

    const renamed = await renameFile(fileId, "renamed.bin");
    expect(renamed.status).toBe(200);

    // The client PUTs to the presigned URL it already had — which still points
    // at the ORIGINAL key, since the URL was minted before the rename.
    await putViaPresignedUrl(started.body.uploadUrl!, "bytes");

    const done = await completeUpload(fileId, "renamed.bin", "/rn");
    expect(done.detail).not.toContain("upload_not_found");
    expect(done.status).toBe(200);
    const body = done.body as { file: { size: number; name: string } };
    expect(body.file.size).toBe(5);
    expect(body.file.name).toBe("renamed.bin");

    const [row] = await runtime.db.select().from(files).where(eq(files.id, fileId));
    expect(row.s3Uri).toBe(runtime.storage.createS3Uri(buckets.drive, originalKey));
  });

  it("cleanup of a renamed pending row deletes the ORIGINAL object key, not a renamed one", async () => {
    const started = await startUpload("abandoned-original.bin", "/rn2", 5);
    const fileId = started.body.fileId!;
    const originalKey = driveObjectKey(fileId, "abandoned-original.bin");
    const renamedKey = driveObjectKey(fileId, "abandoned-renamed.bin");

    await putViaPresignedUrl(started.body.uploadUrl!, "bytes");
    expect(runtime.storage.objects.has(`drive/${originalKey}`)).toBe(true);

    const renamed = await renameFile(fileId, "abandoned-renamed.bin");
    expect(renamed.status).toBe(200);

    // Age the row past the reclaim window and reclaim it directly (deterministic,
    // unlike the sampled sweep).
    await runtime.db.update(files)
      .set({ createdAt: new Date(Date.now() - PENDING_UPLOAD_TTL_MS - 60_000).toISOString() })
      .where(eq(files.id, fileId));
    const [row] = await runtime.db.select().from(files).where(eq(files.id, fileId));

    const reclaimed = await reclaimStalePendingUpload(runtime.db, runtime.storage as never, row);
    expect(reclaimed).toBe(true);

    // The real object (at the ORIGINAL key) must be gone — not leaked as an orphan.
    expect(runtime.storage.objects.has(`drive/${originalKey}`)).toBe(false);
    // No object was ever written under the renamed key, so it must not exist either.
    expect(runtime.storage.objects.has(`drive/${renamedKey}`)).toBe(false);
  });

  it("backward-compat: an old-format pending:{size} marker (no key segment) still completes when the name is unchanged", async () => {
    const fileId = "legacy-pending-file";
    const timestamp = new Date().toISOString();
    await runtime.db.insert(files).values({
      id: fileId,
      name: "legacy.bin",
      path: "/legacy/legacy.bin",
      parentPath: "/legacy",
      isFolder: 0,
      size: 0,
      contentType: "application/octet-stream",
      s3Uri: "pending:5",
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerId: null,
    } as never);

    const legacyKey = driveObjectKey(fileId, "legacy.bin");
    await runtime.storage.from(buckets.drive).put(legacyKey, new TextEncoder().encode("bytes"), {
      contentType: "application/octet-stream",
    });

    const done = await completeUpload(fileId, "legacy.bin", "/legacy");
    expect(done.detail).not.toContain("upload_not_found");
    expect(done.status).toBe(200);
    const body = done.body as { file: { size: number } };
    expect(body.file.size).toBe(5);
  });
});
