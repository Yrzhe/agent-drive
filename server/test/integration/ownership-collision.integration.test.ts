import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { files, memories, contacts, bundleVersions } from "../../src/defs";
import {
  jsonHeaders,
  putViaPresignedUrl,
  resetRuntime,
  runtime,
  seedBundleRow,
  seedContact,
  seedDriveFile,
  seedFolder,
  seedMemory,
  useSession,
} from "./edge-runtime";

type FileRow = typeof files.$inferSelect;
type BundleVersionRow = typeof bundleVersions.$inferSelect;

describe("Part ①b — per-owner uniqueness (#30)", () => {
  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  it("two owners can each hold /report.txt", async () => {
    await seedDriveFile({ id: "fa", path: "/report.txt", body: "a", ownerId: "A" });
    await seedDriveFile({ id: "fb", path: "/report.txt", body: "b", ownerId: "B" }); // must NOT throw
    const rows = await runtime.db.select().from(files).where(eq(files.path, "/report.txt"));
    expect(rows.map((r: FileRow) => r.ownerId).sort()).toEqual(["A", "B"]);
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
    expect(rows.map((r: BundleVersionRow) => r.ownerId).sort()).toEqual(["A", "B"]);
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
    expect(
      rows.filter((r: FileRow) => r.isFolder === 1).map((r: FileRow) => r.ownerId).sort()
    ).toEqual(["A", "B"]);
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

  it("same owner cannot hold memory key 'dup' twice", async () => {
    await seedMemory({ id: "m-dup-1", key: "dup", content: "a", ownerId: "A" });
    await expect(seedMemory({ id: "m-dup-2", key: "dup", content: "b", ownerId: "A" }))
      .rejects.toThrow(/unique/i);
  });

  it("same owner cannot hold contact name 'dup' twice", async () => {
    await seedContact({ id: "c-dup-name-1", name: "dup", url: "https://a.dup.example", publicKeyJwk: {}, ownerId: "A" });
    await expect(
      seedContact({ id: "c-dup-name-2", name: "dup", url: "https://b.dup.example", publicKeyJwk: {}, ownerId: "A" })
    ).rejects.toThrow(/unique/i);
  });

  it("same owner cannot hold contact url twice, even under a different name", async () => {
    await seedContact({ id: "c-dup-url-1", name: "dup-a", url: "https://shared.dup.example", publicKeyJwk: {}, ownerId: "A" });
    await expect(
      seedContact({ id: "c-dup-url-2", name: "dup-b", url: "https://shared.dup.example", publicKeyJwk: {}, ownerId: "A" })
    ).rejects.toThrow(/unique/i);
  });

  it("two keyless memories for the SAME owner both insert fine — NULL keys are distinct under the composite unique", async () => {
    await seedMemory({ id: "mk1", key: null, content: "first note", ownerId: "A" });
    await seedMemory({ id: "mk2", key: null, content: "second note", ownerId: "A" }); // must NOT throw
    const rows = await runtime.db.select().from(memories).where(and(isNull(memories.key), eq(memories.ownerId, "A")));
    expect(rows.length).toBe(2);
  });

  it("REST: creating a folder at a path the SAME owner already has returns a clean 409 path_conflict, not 500", async () => {
    const { default: app } = await import("../../src/index");
    useSession({ id: "A" });

    const first = await app.request("/api/public/v1/folders", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "docs", path: "/" }),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/api/public/v1/folders", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "docs", path: "/" }),
    });
    expect(second.status).toBe(409); // must NOT be a raw 500
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("path_conflict");
  });

  it("two owners can each create folder /shared-rest via REST and each reads back only their own", async () => {
    const { default: app } = await import("../../src/index");

    useSession({ id: "A" });
    const createA = await app.request("/api/public/v1/folders", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "shared-rest", path: "/" }),
    });
    expect(createA.status).toBe(200);
    const listA = await app.request("/api/public/v1/files?path=/", { headers: jsonHeaders() });
    const { files: filesAfterA } = (await listA.json()) as { files: Array<{ path: string }> };
    expect(filesAfterA.map((f) => f.path)).toEqual(["/shared-rest"]);

    useSession({ id: "B" });
    const createB = await app.request("/api/public/v1/folders", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "shared-rest", path: "/" }),
    });
    expect(createB.status).toBe(200); // must NOT throw even though A already holds this path
    const listB = await app.request("/api/public/v1/files?path=/", { headers: jsonHeaders() });
    const { files: filesB } = (await listB.json()) as { files: Array<{ path: string }> };
    expect(filesB.map((f) => f.path)).toEqual(["/shared-rest"]); // only B's own row, not A's

    const rows = await runtime.db.select().from(files).where(eq(files.path, "/shared-rest"));
    expect(rows.map((r: FileRow) => r.ownerId).sort()).toEqual(["A", "B"]);
  });

  it("two owners can each upload /twin.txt via the REST upload flow and each reads back only their own", async () => {
    const { default: app } = await import("../../src/index");

    async function uploadAsOwner(ownerId: string, content: string): Promise<void> {
      useSession({ id: ownerId });
      const uploadRes = await app.request("/api/public/v1/files/upload", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ filename: "twin.txt", path: "/", contentType: "text/plain", size: content.length }),
      });
      expect(uploadRes.status).toBe(200); // must NOT throw — same path, different owner
      const { fileId, uploadUrl } = (await uploadRes.json()) as { fileId: string; uploadUrl: string };
      await putViaPresignedUrl(uploadUrl, content, "text/plain");
      const completeRes = await app.request("/api/public/v1/files/upload/complete", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ fileId, filename: "twin.txt", path: "/" }),
      });
      expect(completeRes.status).toBe(200);
    }

    await uploadAsOwner("A", "owner A's content");
    await uploadAsOwner("B", "owner B's content");

    useSession({ id: "A" });
    const listA = await app.request("/api/public/v1/files?path=/", { headers: jsonHeaders() });
    const { files: filesA } = (await listA.json()) as { files: Array<{ path: string }> };
    expect(filesA).toHaveLength(1);
    expect(filesA[0]?.path).toBe("/twin.txt");

    useSession({ id: "B" });
    const listB = await app.request("/api/public/v1/files?path=/", { headers: jsonHeaders() });
    const { files: filesB } = (await listB.json()) as { files: Array<{ path: string }> };
    expect(filesB).toHaveLength(1);
    expect(filesB[0]?.path).toBe("/twin.txt");

    const rows = await runtime.db.select().from(files).where(eq(files.path, "/twin.txt"));
    expect(rows.map((r: FileRow) => r.ownerId).sort()).toEqual(["A", "B"]);
  });

  it("owner B trashing their own /shared folder leaves owner A's colliding file at /shared/x.txt untouched (#30 Part ①b final review)", async () => {
    const { default: app } = await import("../../src/index");

    // B owns the folder /shared itself.
    await seedFolder("/shared", "B");
    // A owns a real FILE at a path inside that same subtree — a cross-owner path collision.
    await seedDriveFile({ id: "a-shared-x", path: "/shared/x.txt", body: "A's content", ownerId: "A" });

    const [bFolder] = await runtime.db.select().from(files).where(and(eq(files.path, "/shared"), eq(files.ownerId, "B"))).limit(1);
    expect(bFolder).toBeDefined();

    useSession({ id: "B" });
    const trashRes = await app.request(`/api/public/v1/files/${bFolder.id}`, { method: "DELETE", headers: jsonHeaders() });
    expect(trashRes.status).toBe(200);

    const [aFile] = await runtime.db.select().from(files).where(eq(files.id, "a-shared-x")).limit(1);
    expect(aFile).toBeDefined();
    expect(aFile?.path).toBe("/shared/x.txt"); // not tombstoned/path-mangled
    expect(aFile?.deletedAt).toBeNull();
    expect(aFile?.ownerId).toBe("A");
  });

  it("sendFileToContact cannot resolve another owner's file by a colliding path (#30 Part ①b final review)", async () => {
    const { sendFileToContact } = await import("../../src/lib/peering");

    // B owns a file at /b-secret.txt; A owns a contact and tries to send that same path.
    await seedDriveFile({ id: "b-secret", path: "/b-secret.txt", body: "B's secret", ownerId: "B" });
    await seedContact({ id: "contact-a", name: "peer-a", url: "https://peer-a.example", publicKeyJwk: {}, ownerId: "A" });
    const [contact] = await runtime.db.select().from(contacts).where(eq(contacts.id, "contact-a")).limit(1);
    expect(contact).toBeDefined();

    await expect(
      sendFileToContact(runtime.db as never, runtime.storage as never, contact, "/b-secret.txt", null, "https://a.example")
    ).rejects.toThrow(/file_not_found/);
  });

  it("two owners can each remember memory key 'profile-rest' via REST and each reads back only their own", async () => {
    const { default: app } = await import("../../src/index");

    async function rememberAsOwner(ownerId: string, content: string): Promise<{ created: boolean }> {
      useSession({ id: ownerId });
      const res = await app.request("/api/public/v1/memory", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ content, key: "profile-rest" }),
      });
      expect(res.status).toBe(201); // fresh create for THIS owner, never a cross-owner update
      return (await res.json()) as { created: boolean };
    }

    const a = await rememberAsOwner("A", "A's profile");
    expect(a.created).toBe(true);
    const b = await rememberAsOwner("B", "B's profile"); // must NOT throw / must NOT update A's row
    expect(b.created).toBe(true);

    useSession({ id: "A" });
    const listA = await app.request("/api/public/v1/memory", { headers: jsonHeaders() });
    const { memories: memoriesA } = (await listA.json()) as { memories: Array<{ content: string }> };
    expect(memoriesA).toHaveLength(1);
    expect(memoriesA[0]?.content).toBe("A's profile");

    useSession({ id: "B" });
    const listB = await app.request("/api/public/v1/memory", { headers: jsonHeaders() });
    const { memories: memoriesB } = (await listB.json()) as { memories: Array<{ content: string }> };
    expect(memoriesB).toHaveLength(1);
    expect(memoriesB[0]?.content).toBe("B's profile");
  });
});
