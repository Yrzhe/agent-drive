import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { buckets, files } from "@defs";

import app from "../../src/index";
import { maybePurgeStalePendingUploads, reclaimStalePendingUpload } from "../../src/lib/pending-uploads";
import { jsonHeaders, resetRuntime, runtime, seedDriveFile, useBearer, useSession } from "./edge-runtime";

async function errorCode(response: Response): Promise<string | undefined> {
  return (await response.json() as { error?: { code?: string } }).error?.code;
}

async function upload(body: { filename: string; path?: string; size: number; contentType?: string }): Promise<Response> {
  return app.request("/api/public/v1/files/upload", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ contentType: "application/octet-stream", path: "/", ...body }),
  });
}

async function complete(body: { fileId: string; filename: string; path?: string }): Promise<Response> {
  return app.request("/api/public/v1/files/upload/complete", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ path: "/", ...body }),
  });
}

async function insertPending(id: string, name: string, ageMs: number): Promise<void> {
  const at = new Date(Date.now() - ageMs).toISOString();
  await runtime.db.insert(files).values({
    id, name, path: `/${name}`, parentPath: "/", isFolder: 0, size: 0,
    contentType: "text/plain", s3Uri: "pending:5", createdAt: at, updatedAt: at,
  });
}

describe("storage limits + pending cleanup", () => {
  beforeEach(() => {
    resetRuntime();
    useSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("rejects /upload when the declared size exceeds MAX_FILE_BYTES", async () => {
    runtime.vars.set("MAX_FILE_BYTES", "100");
    const response = await upload({ filename: "big.bin", size: 200 });
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("file_too_large");
  });

  it("rejects /upload when it would exceed MAX_TOTAL_BYTES", async () => {
    runtime.vars.set("MAX_TOTAL_BYTES", "100");
    await seedDriveFile({ id: "used", path: "/used.bin", body: "x".repeat(80) });
    const response = await upload({ filename: "more.bin", size: 50 });
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("quota_exceeded");
  });

  it("allows /upload within limits and with quota disabled (0 = unlimited)", async () => {
    runtime.vars.set("MAX_FILE_BYTES", "1000");
    runtime.vars.set("MAX_TOTAL_BYTES", "0");
    const response = await upload({ filename: "ok.bin", size: 50 });
    expect(response.status).toBe(200);
  });

  it("cleans up an upload whose real size breaches the limit at /complete", async () => {
    runtime.vars.set("MAX_FILE_BYTES", "100");
    const ticket = await upload({ filename: "edge.bin", size: 95 }); // declared passes (< 100)
    expect(ticket.status).toBe(200);
    const { fileId } = await ticket.json() as { fileId: string };

    // Real object is 104 bytes: within 10% of declared 95, but over the 100-byte limit.
    await runtime.storage.from(buckets.drive).put(`${fileId}/${encodeURIComponent("edge.bin")}`, new Uint8Array(104));
    const done = await complete({ fileId, filename: "edge.bin" });

    expect(done.status).toBe(413);
    expect(await errorCode(done)).toBe("file_too_large");
    expect((await runtime.db.select().from(files).where(eq(files.id, fileId)))[0]).toBeUndefined();
    expect(await runtime.storage.from(buckets.drive).head(`${fileId}/${encodeURIComponent("edge.bin")}`)).toBeNull();
  });

  it("reclaims a stale pending upload squatting a path (PUT URL expired)", async () => {
    await insertPending("stale-pending", "doc.txt", 2 * 60 * 60 * 1000); // 2h ago (> 1h)
    const response = await upload({ filename: "doc.txt", size: 10 });
    expect(response.status).toBe(200);
    // Old ticket reclaimed; a fresh row now owns the path.
    const [row] = await runtime.db.select().from(files).where(eq(files.path, "/doc.txt"));
    expect(row?.id).not.toBe("stale-pending");
  });

  it("does NOT reclaim a fresh pending upload (PUT URL still valid)", async () => {
    await insertPending("fresh-pending", "wip.txt", 5 * 60 * 1000); // 5 min ago
    const response = await upload({ filename: "wip.txt", size: 10 });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("path_conflict");
  });

  it("sweeps abandoned pending uploads past the 24h TTL, sparing fresh and real files", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // force the sampled sweep to run

    await insertPending("abandoned", "a.txt", 25 * 60 * 60 * 1000); // 25h ago (> 24h TTL)
    await runtime.storage.from(buckets.drive).put(`abandoned/${encodeURIComponent("a.txt")}`, new Uint8Array(5));
    await insertPending("still-fresh", "b.txt", 60 * 1000); // 1 min ago
    await seedDriveFile({ id: "real", path: "/real.txt", body: "keep" });

    await maybePurgeStalePendingUploads(runtime.db, runtime.storage);

    expect((await runtime.db.select().from(files).where(eq(files.id, "abandoned")))[0]).toBeUndefined();
    expect(await runtime.storage.from(buckets.drive).head(`abandoned/${encodeURIComponent("a.txt")}`)).toBeNull();
    expect((await runtime.db.select().from(files).where(eq(files.id, "still-fresh")))[0]).toBeDefined();
    expect((await runtime.db.select().from(files).where(eq(files.id, "real")))[0]).toBeDefined();
  });

  it("does NOT delete a file completed concurrently while cleanup held a stale pending snapshot", async () => {
    // Snapshot a pending row, then let it 'complete' (real object + size) before cleanup deletes.
    await insertPending("racer", "doc.txt", 2 * 60 * 60 * 1000);
    const [staleSnapshot] = await runtime.db.select().from(files).where(eq(files.id, "racer"));
    await runtime.storage.from(buckets.drive).put(`racer/${encodeURIComponent("doc.txt")}`, new Uint8Array(9));

    // The upload completes between the sweep's SELECT and its DELETE.
    await runtime.db.update(files)
      .set({ size: 9, s3Uri: runtime.storage.createS3Uri(buckets.drive, `racer/${encodeURIComponent("doc.txt")}`) })
      .where(eq(files.id, "racer"));

    const reclaimed = await reclaimStalePendingUpload(runtime.db, runtime.storage, staleSnapshot);

    expect(reclaimed).toBe(false); // conditional claim matched nothing — the file is live now
    expect((await runtime.db.select().from(files).where(eq(files.id, "racer")))[0]?.size).toBe(9);
    expect(await runtime.storage.from(buckets.drive).head(`racer/${encodeURIComponent("doc.txt")}`)).not.toBeNull();
  });

  it("handles a zero-byte upload without treating the completed file as pending", async () => {
    const ticket = await upload({ filename: "empty.txt", size: 0 });
    expect(ticket.status).toBe(200);
    const { fileId } = await ticket.json() as { fileId: string };
    await runtime.storage.from(buckets.drive).put(`${fileId}/${encodeURIComponent("empty.txt")}`, new Uint8Array(0));

    const done = await complete({ fileId, filename: "empty.txt" });
    expect(done.status).toBe(200);

    // A completed 0-byte file has a real s3Uri, so the pending sweep must never touch it.
    vi.spyOn(Math, "random").mockReturnValue(0);
    await runtime.db.update(files).set({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }).where(eq(files.id, fileId));
    await maybePurgeStalePendingUploads(runtime.db, runtime.storage);
    expect((await runtime.db.select().from(files).where(eq(files.id, fileId)))[0]).toBeDefined();
  });

  it("caps MCP write_file at 5 MB and counts it against the quota", async () => {
    const headers = jsonHeaders(useBearer(["write:drive", "read:drive", "path:/"]));
    const call = (content: string) => app.request("/api/public/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "write_file", arguments: { path: "/note.txt", content } },
      }),
    });

    const tooBig = await (await call("a".repeat(5 * 1024 * 1024 + 1))).json() as { error?: { code?: number; message?: string } };
    expect(tooBig.error?.message).toContain("file_too_large");

    const ok = await (await call("hello")).json() as { result?: unknown; error?: unknown };
    expect(ok.error).toBeUndefined();
    expect(ok.result).toBeDefined();
  });

  it("caps MCP read_file at 5 MB using the real R2 object size (immune to a stale DB size)", async () => {
    const headers = jsonHeaders(useBearer(["read:drive", "path:/"]));
    // Small DB size, but the actual object is 6 MB (models a re-PUT after complete).
    await seedDriveFile({ id: "bigread", path: "/big.txt", body: "small" });
    await runtime.storage.from(buckets.drive).put(`bigread/${encodeURIComponent("big.txt")}`, new Uint8Array(6 * 1024 * 1024));
    await runtime.db.update(files).set({ size: 5 }).where(eq(files.id, "bigread"));

    const response = await app.request("/api/public/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/big.txt" } } }),
    });
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain("file_too_large");
  });
});
