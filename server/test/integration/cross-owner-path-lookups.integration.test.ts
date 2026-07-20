import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buckets, bundleVersions, files } from "../../src/defs";

import {
  jsonHeaders,
  resetRuntime,
  runtime,
  seedDriveFile,
  useSession,
} from "./edge-runtime";

type FileRow = typeof files.$inferSelect;

/**
 * #65 audit — the same bug shape as #65 (a `files.path`-keyed lookup with no owner
 * filter) in code that then OVERWRITES, SERVES, or DESTROYS. Paths became per-owner
 * unique in #30, so two owners can hold the same path and an unscoped lookup can
 * resolve the wrong owner's row.
 */

const BUNDLE_PREFIX = "/bundles/app";
const MANIFEST_PATH = `${BUNDLE_PREFIX}/manifest.json`;

async function manifestRowOf(ownerId: string): Promise<FileRow | undefined> {
  const [row] = await runtime.db
    .select()
    .from(files)
    .where(and(eq(files.path, MANIFEST_PATH), eq(files.ownerId, ownerId)))
    .limit(1);
  return row;
}

async function readDriveObject(row: FileRow | undefined): Promise<string | null> {
  if (!row?.s3Uri) return null;
  const parsed = runtime.storage.tryParseS3Uri(row.s3Uri);
  if (!parsed) return null;
  const obj = await runtime.storage.from(buckets.drive).get(parsed.path);
  return obj ? new TextDecoder().decode(new Uint8Array(obj.body)) : null;
}

async function commitBundle(
  ownerId: string,
  manifest: Record<string, unknown>,
  ifMatch?: string
): Promise<Response> {
  const { default: app } = await import("../../src/index");
  useSession({ id: ownerId });
  return app.request("/api/public/v1/bundles/commit", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ prefix: BUNDLE_PREFIX, ...(ifMatch ? { ifMatch } : {}), manifest }),
  });
}

describe("#65 audit — bundle commit is owner-scoped", () => {
  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  it("owner A's push does NOT overwrite owner B's manifest row or R2 object at the same prefix", async () => {
    const bRes = await commitBundle("B", { version: 1, name: "b-bundle", hash: "hash-B", machineId: "machine-B", files: [] });
    expect(bRes.status).toBe(200);

    const bBefore = await manifestRowOf("B");
    expect(bBefore).toBeDefined();
    const bBytesBefore = await readDriveObject(bBefore);
    expect(bBytesBefore).toContain("machine-B");

    const aRes = await commitBundle("A", { version: 1, name: "a-bundle", hash: "hash-A", machineId: "machine-A", files: [] });
    expect(aRes.status).toBe(200);

    // B's row is byte-for-byte untouched: same id, same s3Uri, same size, still owned by B.
    const bAfter = await manifestRowOf("B");
    expect(bAfter).toBeDefined();
    expect(bAfter!.id).toBe(bBefore!.id);
    expect(bAfter!.s3Uri).toBe(bBefore!.s3Uri);
    expect(bAfter!.size).toBe(bBefore!.size);
    expect(bAfter!.ownerId).toBe("B");
    // ...and B's R2 object still holds B's manifest, not A's.
    const bBytesAfter = await readDriveObject(bAfter);
    expect(bBytesAfter).toBe(bBytesBefore);
    expect(bBytesAfter).toContain("machine-B");
    expect(bBytesAfter).not.toContain("machine-A");

    // A got their OWN manifest row (distinct id + distinct R2 object).
    const aRow = await manifestRowOf("A");
    expect(aRow).toBeDefined();
    expect(aRow!.id).not.toBe(bBefore!.id);
    expect(aRow!.s3Uri).not.toBe(bBefore!.s3Uri);
    expect(await readDriveObject(aRow)).toContain("machine-A");
  });

  it("owner A's .history snapshot never contains owner B's manifest content", async () => {
    // B pushes first, so B's manifest row is the one an UNSCOPED path lookup finds.
    expect((await commitBundle("B", { version: 1, hash: "hash-B", machineId: "machine-B-SECRET", files: [{ path: "b-only.txt", hash: "hb", size: 1 }] })).status).toBe(200);

    // A's first push creates A's own bundle (no history snapshot — no previous version yet).
    const aFirst = await commitBundle("A", { version: 1, hash: "hash-A1", machineId: "machine-A", files: [] });
    expect(aFirst.status).toBe(200);
    const { versionId: aVersion1 } = (await aFirst.json()) as { versionId: string };

    // A's second push snapshots the CURRENT manifest into A's readable `.history/`.
    const aSecond = await commitBundle("A", { version: 1, hash: "hash-A2", machineId: "machine-A", files: [] }, aVersion1);
    expect(aSecond.status).toBe(200);

    const historyRows = await runtime.db
      .select()
      .from(files)
      .where(and(eq(files.parentPath, `${BUNDLE_PREFIX}/.history`), eq(files.ownerId, "A")));
    expect(historyRows.length).toBeGreaterThan(0);

    for (const row of historyRows) {
      const body = await readDriveObject(row);
      expect(body).not.toBeNull();
      expect(body).not.toContain("machine-B-SECRET"); // B's machineId must never leak
      expect(body).not.toContain("b-only.txt"); // nor B's file list
      expect(body).toContain("machine-A");
    }

    // Same-owner behavior preserved: the snapshot IS A's own previous version.
    const [snapshot] = historyRows;
    expect(await readDriveObject(snapshot)).toContain("hash-A1");
  });

  it("same-owner: A's own manifest row IS updated in place on a repeat push", async () => {
    const first = await commitBundle("A", { version: 1, hash: "hash-A1", machineId: "machine-A", files: [] });
    expect(first.status).toBe(200);
    const { versionId } = (await first.json()) as { versionId: string };
    const before = await manifestRowOf("A");

    const second = await commitBundle("A", { version: 1, hash: "hash-A2", machineId: "machine-A", files: [] }, versionId);
    expect(second.status).toBe(200);

    const after = await manifestRowOf("A");
    expect(after!.id).toBe(before!.id); // same row, updated in place
    expect(await readDriveObject(after)).toContain("hash-A2");

    const rows = await runtime.db.select().from(files).where(eq(files.path, MANIFEST_PATH));
    expect(rows).toHaveLength(1); // no duplicate row was created
  });
});

describe("#65 audit — public bundle endpoint is scoped to the publishing owner", () => {
  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  const PUBLIC_ID = "pb_owner_a";

  /**
   * B (unpublished) holds the same paths A publishes. B is seeded FIRST so an unscoped
   * lookup resolves B's rows — this endpoint is PUBLIC and unauthenticated, so resolving
   * B's rows means handing out presigned download URLs for another owner's private files.
   */
  async function seedCollidingBundles(): Promise<void> {
    const aManifest = {
      version: 1,
      hash: "hash-A",
      machineId: "machine-A",
      versionId: "dv_a",
      files: [
        { path: "secret.txt", hash: "hs", size: 9 },
        { path: "ok.txt", hash: "ho", size: 2 },
      ],
    };
    const bManifest = { version: 1, hash: "hash-B", machineId: "machine-B-SECRET", versionId: "dv_b", files: [{ path: "secret.txt", hash: "hs", size: 9 }] };

    // B first — same paths, no published bundle of their own.
    await seedDriveFile({ id: "b-manifest", path: MANIFEST_PATH, body: JSON.stringify(bManifest), contentType: "application/json", ownerId: "B" });
    await seedDriveFile({ id: "b-secret", path: `${BUNDLE_PREFIX}/secret.txt`, body: "B SECRET", ownerId: "B" });

    // A publishes. A has NO secret.txt of their own, only ok.txt.
    await seedDriveFile({ id: "a-manifest", path: MANIFEST_PATH, body: JSON.stringify(aManifest), contentType: "application/json", ownerId: "A" });
    await seedDriveFile({ id: "a-ok", path: `${BUNDLE_PREFIX}/ok.txt`, body: "ok", ownerId: "A" });

    const ts = new Date().toISOString();
    await runtime.db.insert(bundleVersions).values({
      id: "bv-a", prefix: BUNDLE_PREFIX, publicId: PUBLIC_ID, currentVersionId: "dv_a", previousVersionId: null,
      machineId: "machine-A", hash: "hash-A", fileCount: 2, totalSize: 11, pushedAt: ts, updatedAt: ts, ownerId: "A",
    } as never);
  }

  it("serves A's manifest, never B's same-path manifest", async () => {
    const { default: app } = await import("../../src/index");
    await seedCollidingBundles();

    const res = await app.request(`/api/public/b/${PUBLIC_ID}/manifest`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hash-A");
    expect(body).not.toContain("machine-B-SECRET");
  });

  it("refuses to hand out a download URL for B's file at a path A's manifest lists", async () => {
    const { default: app } = await import("../../src/index");
    await seedCollidingBundles();

    const res = await app.request(`/api/public/b/${PUBLIC_ID}/file?path=secret.txt`);
    expect(res.status).toBe(404); // A has no secret.txt; B's row must NOT be resolved
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("file_not_found");
  });

  it("same-owner: A's own bundle file is still downloadable", async () => {
    const { default: app } = await import("../../src/index");
    await seedCollidingBundles();

    const res = await app.request(`/api/public/b/${PUBLIC_ID}/file?path=ok.txt`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { downloadUrl: string };
    expect(body.downloadUrl).toContain("a-ok"); // A's own object key
  });

  it("/current summarises A's bundle without reading B's manifest", async () => {
    const { default: app } = await import("../../src/index");
    await seedCollidingBundles();

    const res = await app.request(`/api/public/b/${PUBLIC_ID}/current`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hash: string; versionId: string };
    expect(body.hash).toBe("hash-A");
    expect(body.versionId).toBe("dv_a");
  });
});

describe("#65 audit — a purge can never take a LIVE row", () => {
  beforeEach(() => resetRuntime());
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => runtime.sqlite?.close());

  const STALE = "2020-01-01T00:00:00.000Z";

  /** Trash the pre-tombstone way: deletedAt set, path left at its original value. */
  async function legacyTrash(id: string, at = STALE): Promise<void> {
    await runtime.db.update(files).set({ deletedAt: at }).where(eq(files.id, id));
  }

  async function objectExists(fileId: string, key: string): Promise<boolean> {
    void fileId;
    return (await runtime.storage.from(buckets.drive).get(key)) !== null;
  }

  async function keyOf(fileId: string): Promise<string> {
    const [row] = await runtime.db.select().from(files).where(eq(files.id, fileId)).limit(1);
    return runtime.storage.tryParseS3Uri(row!.s3Uri!)!.path;
  }

  /**
   * Legacy null-owner trashed `/notes` + another owner's LIVE `/notes/live.md`. With a
   * null owner the subtree sweep is unscoped, so only the `deletedAt` floor keeps the
   * live row alive.
   */
  async function seedLegacyTrashOverLiveRows(): Promise<FileRow> {
    await seedDriveFile({ id: "legacy-old", path: "/notes/old.md", body: "legacy", ownerId: null });
    await seedDriveFile({ id: "b-live", path: "/notes/live.md", body: "B LIVE", ownerId: "B" });
    const [legacyFolder] = await runtime.db
      .select()
      .from(files)
      .where(and(eq(files.path, "/notes"), eq(files.isFolder, 1)))
      .limit(1);
    await legacyTrash(legacyFolder.id);
    await legacyTrash("legacy-old");
    return legacyFolder as FileRow;
  }

  it("hardPurgeSubtree leaves a LIVE sibling row (and its bytes) intact", async () => {
    const { hardPurgeSubtree } = await import("../../src/lib/trash");
    const root = await seedLegacyTrashOverLiveRows();
    const liveKey = await keyOf("b-live");

    await hardPurgeSubtree(runtime.db as never, runtime.storage as never, root, null);

    const [live] = await runtime.db.select().from(files).where(eq(files.id, "b-live")).limit(1);
    expect(live).toBeDefined(); // LIVE row survived an unscoped purge
    expect(live.deletedAt).toBeNull();
    expect(await objectExists("b-live", liveKey)).toBe(true); // bytes survived too

    // The trashed rows themselves ARE gone.
    const [old] = await runtime.db.select().from(files).where(eq(files.id, "legacy-old")).limit(1);
    expect(old).toBeUndefined();
  });

  it("same-owner: A's own trashed subtree IS still fully purged", async () => {
    const { hardPurgeSubtree } = await import("../../src/lib/trash");
    await seedDriveFile({ id: "a-child", path: "/mine/child.md", body: "A's", ownerId: "A" });
    const [aFolder] = await runtime.db
      .select()
      .from(files)
      .where(and(eq(files.path, "/mine"), eq(files.ownerId, "A")))
      .limit(1);
    const childKey = await keyOf("a-child");
    await legacyTrash(aFolder.id);
    await legacyTrash("a-child");

    const { rowCount } = await hardPurgeSubtree(runtime.db as never, runtime.storage as never, aFolder, "A");
    expect(rowCount).toBe(2);

    expect(await runtime.db.select().from(files).where(eq(files.ownerId, "A"))).toHaveLength(0);
    expect(await objectExists("a-child", childKey)).toBe(false);
  });

  it("maybePurgeStaleTrash skips a null-owner root whose subtree crosses owners", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // force the sampled sweep to run
    const { maybePurgeStaleTrash } = await import("../../src/lib/trash");
    await seedLegacyTrashOverLiveRows();
    const liveKey = await keyOf("b-live");

    await maybePurgeStaleTrash(runtime.db as never, runtime.storage as never);

    const [live] = await runtime.db.select().from(files).where(eq(files.id, "b-live")).limit(1);
    expect(live).toBeDefined();
    expect(live.deletedAt).toBeNull();
    expect(await objectExists("b-live", liveKey)).toBe(true);
  });

  it("maybePurgeStaleTrash still purges a stale OWNER-SCOPED subtree", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { maybePurgeStaleTrash } = await import("../../src/lib/trash");
    await seedDriveFile({ id: "a-stale", path: "/aged/note.md", body: "old", ownerId: "A" });
    const [aFolder] = await runtime.db
      .select()
      .from(files)
      .where(and(eq(files.path, "/aged"), eq(files.ownerId, "A")))
      .limit(1);
    await legacyTrash(aFolder.id);
    await legacyTrash("a-stale");

    await maybePurgeStaleTrash(runtime.db as never, runtime.storage as never);

    expect(await runtime.db.select().from(files).where(eq(files.ownerId, "A"))).toHaveLength(0);
  });

  it("maybePurgeStaleTrash still purges a legacy single-owner (all-null-owner) subtree", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { maybePurgeStaleTrash } = await import("../../src/lib/trash");
    await seedDriveFile({ id: "legacy-only", path: "/legacy/note.md", body: "old", ownerId: null });
    const [folder] = await runtime.db
      .select()
      .from(files)
      .where(and(eq(files.path, "/legacy"), eq(files.isFolder, 1)))
      .limit(1);
    await legacyTrash(folder.id);
    await legacyTrash("legacy-only");

    await maybePurgeStaleTrash(runtime.db as never, runtime.storage as never);

    const remaining = await runtime.db.select().from(files).where(eq(files.id, "legacy-only"));
    expect(remaining).toHaveLength(0); // legacy deployments keep purging as before
  });
});
