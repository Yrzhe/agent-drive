import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buckets, files } from "../../src/defs";
import { ORPHAN_GRACE_MS, reconcileOrphanObjects } from "../../src/lib/orphan-objects";
import { resetRuntime, runtime, seedDriveFile } from "./edge-runtime";

/** Backdate an object's uploadedAt so it falls outside the grace window. */
function ageObject(objectPath: string, ms: number): void {
  const stored = runtime.storage.objects.get(`drive/${objectPath}`);
  if (!stored) throw new Error(`test setup: no object at ${objectPath}`);
  stored.uploadedAt = new Date(Date.now() - ms);
}

function objectExists(objectPath: string): boolean {
  return runtime.storage.objects.has(`drive/${objectPath}`);
}

const OLD = ORPHAN_GRACE_MS + 60_000;

async function sweep(prefix: string): Promise<number> {
  return reconcileOrphanObjects(runtime.db, runtime.storage as never, { prefix });
}

describe("drive-bucket orphan reconciler", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("reaps an object whose file row is gone and is past the grace window", async () => {
    const id = "aaaaOrphanRow";
    await seedDriveFile({ id, path: "/reports/gone.txt", body: "bytes" });
    const key = `${id}/gone.txt`;

    // Simulate batch-4's failure mode: DB row purged, R2 delete failed.
    await runtime.db.delete(files).where(eq(files.id, id));
    ageObject(key, OLD);

    const reaped = await sweep("a");

    expect(reaped).toBe(1);
    expect(objectExists(key)).toBe(false);
  });

  it("does not reap an object inside the grace window (server-side put before its row insert)", async () => {
    const id = "aaaaFreshPut";
    const key = `${id}/inflight.txt`;
    // Object written, row not inserted yet — exactly the mcp/peering/bundle window.
    await runtime.storage.from(buckets.drive).put(key, new TextEncoder().encode("x"), {
      contentType: "text/plain",
    });

    const reaped = await sweep("a");

    expect(reaped).toBe(0);
    expect(objectExists(key)).toBe(true);
  });

  it("does not reap an object whose file row is trashed", async () => {
    const id = "aaaaTrashed";
    await seedDriveFile({ id, path: "/reports/trashed.txt", body: "bytes" });
    const key = `${id}/trashed.txt`;

    await runtime.db.update(files).set({ deletedAt: new Date().toISOString() }).where(eq(files.id, id));
    ageObject(key, OLD);

    const reaped = await sweep("a");

    expect(reaped).toBe(0);
    expect(objectExists(key)).toBe(true);
  });

  it("does not reap an object whose row is a pending upload", async () => {
    const id = "aaaaPending";
    const key = `${id}/pending.bin`;
    await runtime.storage.from(buckets.drive).put(key, new TextEncoder().encode("partial"), {
      contentType: "application/octet-stream",
    });
    const now = new Date().toISOString();
    // /upload inserts this row before presigning, so the object's id always resolves.
    await runtime.db.insert(files).values({
      id,
      name: "pending.bin",
      path: "/pending.bin",
      parentPath: "/",
      isFolder: 0,
      size: 0,
      contentType: "application/octet-stream",
      s3Uri: "pending:123",
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    ageObject(key, OLD);

    const reaped = await sweep("a");

    expect(reaped).toBe(0);
    expect(objectExists(key)).toBe(true);
  });

  it("leaves live files under other prefixes untouched", async () => {
    const orphanId = "aaaaOrphan2";
    await seedDriveFile({ id: orphanId, path: "/a.txt", body: "a" });
    await runtime.db.delete(files).where(eq(files.id, orphanId));
    ageObject(`${orphanId}/a.txt`, OLD);

    const liveId = "bbbbLive";
    await seedDriveFile({ id: liveId, path: "/b.txt", body: "b" });
    ageObject(`${liveId}/b.txt`, OLD);

    await sweep("a");

    expect(objectExists(`${orphanId}/a.txt`)).toBe(false);
    expect(objectExists(`${liveId}/b.txt`)).toBe(true);
  });
});
