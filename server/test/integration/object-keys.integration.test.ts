import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { files } from "../../src/defs";
import { PENDING_UPLOAD_TTL_MS, reclaimStalePendingUpload } from "../../src/lib/pending-uploads";
import app from "../../src/index";
import {
  getViaPresignedUrl,
  jsonHeaders,
  putViaPresignedUrl,
  resetRuntime,
  runtime,
  useBearer,
} from "./edge-runtime";

/**
 * Non-ASCII object keys across the binding <-> presigned-URL boundary (#44).
 *
 * The two SDK families disagree about what `path` means: the binding stores at
 * the literal string, while the presign family embeds it verbatim in a URL that
 * S3 decodes once. Handing both the same pre-encoded string therefore lands on
 * two different keys for any name where encodeURIComponent is not a no-op.
 * ASCII names are a no-op, which is why this stayed hidden — so every case below
 * keeps an ASCII twin to prove the working path does not regress.
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

async function completeUpload(fileId: string, filename: string, path: string) {
  const res = await app.request("/api/public/v1/files/upload/complete", {
    method: "POST",
    headers: jsonHeaders(useBearer(SCOPES)),
    body: JSON.stringify({ fileId, filename, path }),
  });
  const text = await res.text();
  return { status: res.status, detail: text, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

async function mcpWrite(path: string, content: string) {
  const res = await app.request("/api/public/mcp", {
    method: "POST",
    headers: jsonHeaders(useBearer(SCOPES)),
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "write_file", arguments: { path, content } },
    }),
  });
  return await res.json() as { result?: unknown; error?: { message?: string } };
}

async function previewUrl(fileId: string): Promise<string | null> {
  const res = await app.request(`/api/public/v1/files/${fileId}/preview`, {
    headers: jsonHeaders(useBearer(SCOPES)),
  });
  if (res.status !== 200) return null;
  const body = await res.json() as { downloadUrl?: string };
  return body.downloadUrl ?? null;
}

describe("non-ASCII object keys across the binding <-> presigned boundary (#44)", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  describe("presigned upload -> binding head (loud failure: upload_not_found)", () => {
    it.each([
      ["ascii", "probe-ascii.bin"],
      ["chinese", "探针-中文.bin"],
      ["emoji", "probe-🎯.bin"],
      ["space+hash", "a b#c.bin"],
      ["percent", "100%-done.bin"],
      ["plus", "a+b.bin"],
    ])("%s: /upload -> PUT -> /upload/complete records the real size", async (_label, filename) => {
      const started = await startUpload(filename, "/up", 5);
      expect(started.detail).toContain("uploadUrl");

      // The client PUTs to the presigned URL — the object lands where S3 resolves it.
      await putViaPresignedUrl(started.body.uploadUrl!, "bytes");

      const done = await completeUpload(started.body.fileId!, filename, "/up");
      expect(done.detail).not.toContain("upload_not_found");
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ file: { size: 5 } });
    });
  });

  describe("binding write -> presigned read (silent failure: listed but undownloadable)", () => {
    it.each([
      ["ascii", "/mcp/note-ascii.txt"],
      ["chinese", "/mcp/笔记-中文.txt"],
      ["emoji", "/mcp/note-🎯.txt"],
      ["space+hash", "/mcp/a b#c.txt"],
      ["percent", "/mcp/100%-done.txt"],
    ])("%s: MCP write_file -> preview downloads the same bytes", async (_label, path) => {
      const wrote = await mcpWrite(path, "hello");
      expect(wrote.error).toBeUndefined();

      const listed = await app.request(`/api/public/v1/files?path=/mcp`, {
        headers: jsonHeaders(useBearer(SCOPES)),
      });
      const files = (await listed.json() as { files: { id: string; path: string }[] }).files;
      const row = files.find((f) => f.path === path);
      expect(row, "file should be listed").toBeDefined();

      const url = await previewUrl(row!.id);
      expect(url, "preview should issue a download URL").not.toBeNull();

      // The real bug: the row exists and is listed, but the presigned GET 404s.
      const bytes = await getViaPresignedUrl(url!);
      expect(bytes, "presigned GET must resolve the object the binding wrote").not.toBeNull();
      expect(new TextDecoder().decode(bytes!)).toBe("hello");
    });
  });

  describe("share links (the recipient-facing failure)", () => {
    it.each([
      ["ascii", "/share/report-ascii.txt"],
      ["chinese", "/share/报告-中文.txt"],
      ["emoji", "/share/report-🎯.txt"],
    ])("%s: a shared file downloads through its public link", async (_label, path) => {
      // Written via the binding (MCP), fetched via a presigned URL — the crossover
      // that hands a recipient a share link resolving to nothing.
      expect((await mcpWrite(path, "shared-bytes")).error).toBeUndefined();

      const listed = await app.request("/api/public/v1/files?path=/share", {
        headers: jsonHeaders(useBearer(SCOPES)),
      });
      const row = (await listed.json() as { files: { id: string; path: string }[] }).files
        .find((f) => f.path === path);
      expect(row).toBeDefined();

      const created = await app.request("/api/public/v1/shares", {
        method: "POST",
        headers: jsonHeaders(useBearer(SCOPES)),
        body: JSON.stringify({ fileId: row!.id }),
      });
      const createdText = await created.text();
      expect(createdText, "share creation should succeed").toContain("\"share\"");
      const shareId = (JSON.parse(createdText) as { share: { id: string } }).share.id;

      // Recipients exchange the link for a short-lived access token first.
      const access = await app.request(`/api/public/s/${shareId}/access`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(access.status).toBe(200);
      const { accessToken } = await access.json() as { accessToken: string };

      const dl = await app.request(`/api/public/s/${shareId}/download`, {
        headers: { "x-access-token": accessToken },
      });
      expect(dl.status).toBe(200);
      const { downloadUrl } = await dl.json() as { downloadUrl: string };

      const bytes = await getViaPresignedUrl(downloadUrl);
      expect(bytes, "a share link must resolve to the shared object").not.toBeNull();
      expect(new TextDecoder().decode(bytes!)).toBe("shared-bytes");
    });
  });

  describe("pending-upload cleanup reaches the object the client actually PUT", () => {
    it.each([
      ["ascii", "abandoned-ascii.bin"],
      ["chinese", "废弃-中文.bin"],
      ["emoji", "abandoned-🎯.bin"],
    ])("%s: reclaiming an abandoned pending upload removes its object", async (_label, filename) => {
      const started = await startUpload(filename, "/pending", 5);
      expect(started.detail).toContain("uploadUrl");

      // The client PUTs, then never calls /upload/complete.
      await putViaPresignedUrl(started.body.uploadUrl!, "bytes");
      const keysAfterPut = [...runtime.storage.objects.keys()].filter((k) => k.includes(started.body.fileId!));
      expect(keysAfterPut, "the PUT must have landed an object").toHaveLength(1);

      // Age the row past the reclaim window. (Drive the deterministic reclaim, not
      // the 5%-sampled sweep that wraps it — sampling would make this flaky.)
      await runtime.db.update(files)
        .set({ createdAt: new Date(Date.now() - PENDING_UPLOAD_TTL_MS - 60_000).toISOString() })
        .where(eq(files.id, started.body.fileId!));
      const [row] = await runtime.db.select().from(files).where(eq(files.id, started.body.fileId!));

      const reclaimed = await reclaimStalePendingUpload(runtime.db, runtime.storage as never, row);
      expect(reclaimed, "the aged pending row should be reclaimable").toBe(true);

      // Before the fix the delete targeted the encoded key while the object sat at
      // the raw one, so the row went and the object leaked as an orphan.
      const leaked = [...runtime.storage.objects.keys()].filter((k) => k.includes(started.body.fileId!));
      expect(leaked, "cleanup must delete the object the presigned PUT created").toEqual([]);
    });
  });
});
