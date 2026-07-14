import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { buckets, files, shares } from "@defs";

import app from "../../src/index";
import { jsonHeaders, resetRuntime, runtime, seedDriveFile, useSession } from "./edge-runtime";

async function seedFolderShare(folderPath: string, id: string): Promise<void> {
  await runtime.db.insert(shares).values({
    id, fileId: null, folderPath, passwordHash: null, passwordVersion: 1,
    maxDownloads: null, downloadCount: 0, expiresAt: null, createdAt: new Date().toISOString(),
  });
}

async function folderId(path: string): Promise<string> {
  const [row] = await runtime.db.select().from(files).where(eq(files.path, path));
  return row.id;
}

async function allPaths(): Promise<string[]> {
  const rows = await runtime.db.select({ path: files.path }).from(files);
  return rows.map((r: { path: string }) => r.path).sort();
}

describe("folder move/rename/purge consistency", () => {
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

  it("rewrites root + every descendant + linked share atomically on rename", async () => {
    await seedDriveFile({ id: "nested", path: "/docs/sub/a.txt", body: "x" });
    await seedFolderShare("/docs", "share-docs");

    const response = await app.request(`/api/public/v1/files/${await folderId("/docs")}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "papers" }),
    });
    expect(response.status).toBe(200);

    const paths = await allPaths();
    expect(paths).toContain("/papers");
    expect(paths).toContain("/papers/sub");
    expect(paths).toContain("/papers/sub/a.txt");
    expect(paths.some((p) => p.startsWith("/docs"))).toBe(false); // no descendant left behind
    const [share] = await runtime.db.select().from(shares).where(eq(shares.id, "share-docs"));
    expect(share?.folderPath).toBe("/papers");
  });

  it("rewrites root + descendants + share atomically on move", async () => {
    await seedDriveFile({ id: "deep", path: "/src/lib/x.ts", body: "y" });
    await seedFolderShare("/src", "share-src");

    const response = await app.request(`/api/public/v1/files/${await folderId("/src")}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ parentPath: "/archive" }),
    });
    expect(response.status).toBe(200);

    const paths = await allPaths();
    expect(paths).toContain("/archive/src");
    expect(paths).toContain("/archive/src/lib");
    expect(paths).toContain("/archive/src/lib/x.ts");
    expect(paths.some((p) => p === "/src" || p.startsWith("/src/"))).toBe(false);
    const [share] = await runtime.db.select().from(shares).where(eq(shares.id, "share-src"));
    expect(share?.folderPath).toBe("/archive/src");
  });

  it("hard-purge removes both DB rows and R2 objects", async () => {
    await seedDriveFile({ id: "doomed", path: "/tmp/f.txt", body: "gone" });
    const objectPath = `doomed/${encodeURIComponent("f.txt")}`;
    expect(await runtime.storage.from(buckets.drive).head(objectPath)).not.toBeNull();

    // Trash then purge the folder.
    const id = await folderId("/tmp");
    await app.request(`/api/public/v1/files/${id}`, { method: "DELETE" });
    const purge = await app.request(`/api/public/v1/files/${id}/purge`, { method: "DELETE" });
    expect(purge.status).toBe(200);

    expect((await runtime.db.select().from(files).where(eq(files.id, "doomed")))[0]).toBeUndefined();
    expect(await runtime.storage.from(buckets.drive).head(objectPath)).toBeNull();
  });

  it("keeps the DB consistent when R2 deletion fails during purge (orphan, not a broken reference)", async () => {
    await seedDriveFile({ id: "leaky", path: "/x/f.txt", body: "z" });
    const objectPath = `leaky/${encodeURIComponent("f.txt")}`;
    const id = await folderId("/x");
    await app.request(`/api/public/v1/files/${id}`, { method: "DELETE" });

    vi.spyOn(runtime.storage.objects, "delete").mockImplementation(() => {
      throw new Error("R2 unavailable");
    });
    const purge = await app.request(`/api/public/v1/files/${id}/purge`, { method: "DELETE" });
    // Best-effort R2 delete: the already-committed purge must still succeed.
    expect(purge.status).toBe(200);

    // DB rows are gone (consistent). The R2 object is orphaned — present, but NOT a
    // live row pointing at a deleted object.
    expect((await runtime.db.select().from(files).where(eq(files.id, "leaky")))[0]).toBeUndefined();
    vi.restoreAllMocks();
    expect(await runtime.storage.from(buckets.drive).head(objectPath)).not.toBeNull();
  });
});
