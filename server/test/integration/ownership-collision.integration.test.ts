import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { files, memories, contacts, bundleVersions } from "../../src/defs";
import { jsonHeaders, resetRuntime, runtime, seedDriveFile, seedFolder, seedMemory, seedContact, seedBundleRow, useSession } from "./edge-runtime";

describe("Part ①b — per-owner uniqueness (#30)", () => {
  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  it("two owners can each hold /report.txt", async () => {
    await seedDriveFile({ id: "fa", path: "/report.txt", body: "a", ownerId: "A" });
    await seedDriveFile({ id: "fb", path: "/report.txt", body: "b", ownerId: "B" }); // must NOT throw
    const rows = await runtime.db.select().from(files).where(eq(files.path, "/report.txt"));
    expect(rows.map((r) => r.ownerId).sort()).toEqual(["A", "B"]);
  });

  it("same owner cannot hold /report.txt twice", async () => {
    await seedDriveFile({ id: "f1", path: "/dup.txt", body: "a", ownerId: "A" });
    await expect(seedDriveFile({ id: "f2", path: "/dup.txt", body: "b", ownerId: "A" }))
      .rejects.toThrow(/unique/i);
  });

  it("two owners can each hold memory key 'profile' and contact name 'peer'", async () => {
    await seedMemory({ id: "m1", key: "profile", content: "a", ownerId: "A" });
    await seedMemory({ id: "m2", key: "profile", content: "b", ownerId: "B" }); // must NOT throw
    await seedContact({ id: "c1", name: "peer", url: "https://a.peer", publicKeyJwk: {}, ownerId: "A" });
    await seedContact({ id: "c2", name: "peer", url: "https://b.peer", publicKeyJwk: {}, ownerId: "B" }); // must NOT throw
    expect((await runtime.db.select().from(memories).where(eq(memories.key, "profile"))).length).toBe(2);
    expect((await runtime.db.select().from(contacts).where(eq(contacts.name, "peer"))).length).toBe(2);
  });

  it("two owners can each publish a bundle at prefix /proj", async () => {
    await seedBundleRow({ id: "bv-a", prefix: "/proj", publicId: "pb_a", ownerId: "A" });
    await seedBundleRow({ id: "bv-b", prefix: "/proj", publicId: "pb_b", ownerId: "B" }); // must NOT throw (was PK collision)
    const rows = await runtime.db.select().from(bundleVersions).where(eq(bundleVersions.prefix, "/proj"));
    expect(rows.map((r) => r.ownerId).sort()).toEqual(["A", "B"]);
  });

  it("publicId stays globally unique", async () => {
    await seedBundleRow({ id: "bv1", prefix: "/x", publicId: "pb_dup", ownerId: "A" });
    await expect(seedBundleRow({ id: "bv2", prefix: "/y", publicId: "pb_dup", ownerId: "B" })).rejects.toThrow(/unique/i);
  });

  it("remember-by-key is per-owner: B's remember creates B's own row, A's untouched", async () => {
    await seedMemory({ id: "ma", key: "profile", content: "A original", ownerId: "A" });
    const { rememberMemory } = await import("../../src/lib/memory");
    const res = await rememberMemory(runtime.db as never, { content: "B new", key: "profile", ownerId: "B" });
    expect(res.created).toBe(true); // B got a NEW row, did not update A's
    const a = (await runtime.db.select().from(memories).where(and(eq(memories.key, "profile"), eq(memories.ownerId, "A"))))[0];
    expect(a.content).toBe("A original"); // A untouched
    const b = (await runtime.db.select().from(memories).where(and(eq(memories.key, "profile"), eq(memories.ownerId, "B"))))[0];
    expect(b.content).toBe("B new");
  });

  it("owner B moving/trashing/purging their own /shared folder leaves owner A's bundle at /shared/x untouched (#30 Part ①b review)", async () => {
    const { default: app } = await import("../../src/index");

    // A owns a published bundle whose prefix sits inside a subtree B controls.
    await seedBundleRow({ id: "bv-shared-x", prefix: "/shared/x", publicId: "pb_shared_a", ownerId: "A" });
    // B owns the folder /shared itself.
    await seedFolder("/shared", "B");
    const [folder] = await runtime.db.select().from(files).where(eq(files.path, "/shared")).limit(1);

    const assertABundleUntouched = async () => {
      const [row] = await runtime.db.select().from(bundleVersions).where(eq(bundleVersions.id, "bv-shared-x")).limit(1);
      expect(row).toBeDefined();
      expect(row?.prefix).toBe("/shared/x");
      expect(row?.publicId).toBe("pb_shared_a");
      expect(row?.ownerId).toBe("A");
    };

    useSession({ id: "B" });

    // B moves /shared -> /archive/shared.
    const moveRes = await app.request(`/api/public/v1/files/${folder.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ parentPath: "/archive" }),
    });
    expect(moveRes.status).toBe(200);
    await assertABundleUntouched();

    // B trashes the (now-moved) folder.
    const [movedFolder] = await runtime.db.select().from(files).where(eq(files.path, "/archive/shared")).limit(1);
    const trashRes = await app.request(`/api/public/v1/files/${movedFolder.id}`, { method: "DELETE", headers: jsonHeaders() });
    expect(trashRes.status).toBe(200);
    await assertABundleUntouched();

    // B purges the trashed folder.
    const purgeRes = await app.request(`/api/public/v1/files/${movedFolder.id}/purge`, { method: "DELETE", headers: jsonHeaders() });
    expect(purgeRes.status).toBe(200);
    await assertABundleUntouched();
  });

  it("two owners can each auto-create folder /shared via ensureFolderChain", async () => {
    const { ensureFolderChain } = await import("../../src/lib/files");
    await ensureFolderChain(runtime.db as never, "/shared", "A"); // creates A's /shared
    await ensureFolderChain(runtime.db as never, "/shared", "B"); // must NOT throw now (was global-unique 500)
    const rows = await runtime.db.select().from(files).where(eq(files.path, "/shared"));
    expect(rows.filter((r) => r.isFolder === 1).map((r) => r.ownerId).sort()).toEqual(["A", "B"]);
  });

  it("same-owner repeat ensureFolderChain is idempotent, no raw unique error", async () => {
    const { ensureFolderChain } = await import("../../src/lib/files");
    await ensureFolderChain(runtime.db as never, "/x/y", "A");
    await ensureFolderChain(runtime.db as never, "/x/y", "A"); // idempotent
    expect((await runtime.db.select().from(files).where(and(eq(files.path, "/x/y"), eq(files.ownerId, "A")))).length).toBe(1);
  });

  it("concurrent same-owner ensureFolderChain calls for the same path do not throw a raw unique error", async () => {
    // Sequential repeats no-op via the pre-insert existence check (see previous test) — that
    // does NOT exercise the insert's catch. To exercise it, race two calls so both complete
    // their SELECT (finding nothing) before either commits its INSERT: both then attempt to
    // insert the same owner_id+path row, and the loser must hit the unique-conflict catch
    // instead of throwing a raw error.
    const { ensureFolderChain } = await import("../../src/lib/files");
    await Promise.all([
      ensureFolderChain(runtime.db as never, "/race/dir", "A"),
      ensureFolderChain(runtime.db as never, "/race/dir", "A"),
    ]); // must NOT throw — Promise.all rejects (and this await throws) if either call surfaces a raw unique error
    const rows = await runtime.db
      .select()
      .from(files)
      .where(and(eq(files.path, "/race/dir"), eq(files.ownerId, "A")));
    expect(rows.length).toBe(1);
  });
});
