import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { files, memories } from "../../src/defs";
import app from "../../src/index";
import { jsonHeaders, resetRuntime, runtime, seedDriveFile, seedOwner, useSession } from "./edge-runtime";

/**
 * Shared Spaces P1 Task 3 — contribute/remove/list `space_items` REST endpoints.
 * (brief: .superpowers/sdd/task-3-brief.md; design: docs/implementation/2026-07-19-shared-spaces-design.md)
 *
 * NO read-path assertions here (files.list/memory.recall seeing space items is Task 4/5) —
 * these tests only cover the space_items reference rows: contribute, remove, list.
 */
describe("spaces items REST (P1 Task 3)", () => {
  const USER_A = { id: "user-a", email: "alice@x.test" };
  const USER_B = { id: "user-b", email: "bob@x.test" };
  const USER_C = { id: "user-c", email: "carol@x.test" };

  function seedUsers(): void {
    seedOwner({ id: USER_A.id, email: USER_A.email });
    seedOwner({ id: USER_B.id, email: USER_B.email });
    seedOwner({ id: USER_C.id, email: USER_C.email });
  }

  async function createSpace(name = "Team KB"): Promise<{ id: string }> {
    const res = await app.request("/api/public/v1/spaces", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { space: { id: string } }).space;
  }

  async function inviteMember(spaceId: string, email: string, role: string): Promise<Response> {
    return app.request(`/api/public/v1/spaces/${spaceId}/members`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, role }),
    });
  }

  async function contribute(spaceId: string, itemType: string, ref: string): Promise<Response> {
    return app.request(`/api/public/v1/spaces/${spaceId}/items`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ itemType, ref }),
    });
  }

  async function listItems(spaceId: string, query = ""): Promise<Response> {
    return app.request(`/api/public/v1/spaces/${spaceId}/items${query}`);
  }

  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("owner A contributes their own file → 201, appears in the flat attributed list", async () => {
    seedUsers();
    await seedDriveFile({ id: "file-a1", path: "/report.txt", ownerId: USER_A.id });

    useSession(USER_A);
    const space = await createSpace();

    const res = await contribute(space.id, "file", "/report.txt");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: Record<string, unknown> };
    expect(body.item).toMatchObject({
      itemType: "file",
      itemRef: "file-a1",
      name: "report.txt",
      contributedBy: USER_A.id,
    });

    const listRes = await listItems(space.id);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { items: Record<string, unknown>[] };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]).toMatchObject({
      itemType: "file",
      name: "report.txt",
      contributedBy: USER_A.id,
    });
  });

  it("A tries to contribute a file they do NOT own → 403 not_your_resource, nothing inserted", async () => {
    seedUsers();
    await seedDriveFile({ id: "file-c1", path: "/carols-file.txt", ownerId: USER_C.id });

    useSession(USER_A);
    const space = await createSpace();

    const res = await contribute(space.id, "file", "/carols-file.txt");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("not_your_resource");

    const listRes = await listItems(space.id);
    expect(((await listRes.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("contributing a ref that doesn't exist at all also 403s as not_your_resource (no existence leak)", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    const res = await contribute(space.id, "file", "/nope.txt");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("not_your_resource");
  });

  it("a viewer cannot contribute (403 space_forbidden) — contributor+ required", async () => {
    seedUsers();
    await seedDriveFile({ id: "file-b1", path: "/notes.txt", ownerId: USER_B.id });
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "viewer");

    useSession(USER_B);
    const res = await contribute(space.id, "file", "/notes.txt");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("space_forbidden");
  });

  it("a non-member cannot contribute (403 space_forbidden)", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    useSession(USER_C);
    const res = await contribute(space.id, "file", "/whatever.txt");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("space_forbidden");
  });

  it("contributor B contributes their own memory → appears in the list", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "contributor");

    useSession(USER_B);
    const memRes = await app.request("/api/public/v1/memory", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "B's private note", key: "b-note" }),
    });
    expect(memRes.status).toBe(201);
    const memBody = (await memRes.json()) as { memory: { id: string } };

    const res = await contribute(space.id, "memory", memBody.memory.id);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: Record<string, unknown> };
    expect(body.item).toMatchObject({ itemType: "memory", name: "b-note", contributedBy: USER_B.id });

    const listRes = await listItems(space.id);
    const listBody = (await listRes.json()) as { items: Record<string, unknown>[] };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]).toMatchObject({ itemType: "memory", name: "b-note" });
  });

  it("removing a member retracts their contributed items (reference rows only; underlying file survives)", async () => {
    seedUsers();
    await seedDriveFile({ id: "file-bob", path: "/bobs.txt", ownerId: USER_B.id });
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "contributor");

    useSession(USER_B);
    expect((await contribute(space.id, "file", "/bobs.txt")).status).toBe(201);

    useSession(USER_A);
    const removed = await app.request(`/api/public/v1/spaces/${space.id}/members/${USER_B.id}`, {
      method: "DELETE",
      headers: jsonHeaders(),
    });
    expect(removed.status).toBe(200);

    // B's contribution is gone from the space...
    const listBody = (await (await listItems(space.id)).json()) as { items: unknown[] };
    expect(listBody.items).toHaveLength(0);
    // ...but B's real file is untouched.
    const [row] = await runtime.db.select().from(files).where(eq(files.id, "file-bob"));
    expect(row).toBeDefined();
  });

  it("contributing the same ref twice is idempotent — no duplicate row, same item id", async () => {
    seedUsers();
    await seedDriveFile({ id: "file-a2", path: "/dupe.txt", ownerId: USER_A.id });
    useSession(USER_A);
    const space = await createSpace();

    const first = await contribute(space.id, "file", "/dupe.txt");
    const firstBody = (await first.json()) as { item: { id: string } };

    const second = await contribute(space.id, "file", "/dupe.txt");
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { item: { id: string } };
    expect(secondBody.item.id).toBe(firstBody.item.id);

    const listRes = await listItems(space.id);
    expect(((await listRes.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("B removes A's item as a non-editor contributor → 403; editor removes A's item → ok, underlying file survives", async () => {
    seedUsers();
    await seedDriveFile({ id: "file-a3", path: "/shared.txt", ownerId: USER_A.id });
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "contributor");

    const contributeRes = await contribute(space.id, "file", "/shared.txt");
    const item = ((await contributeRes.json()) as { item: { id: string } }).item;

    useSession(USER_B);
    const deniedRes = await app.request(`/api/public/v1/spaces/${space.id}/items/${item.id}`, { method: "DELETE" });
    expect(deniedRes.status).toBe(403);
    const deniedBody = (await deniedRes.json()) as { error?: { code?: string } };
    expect(deniedBody.error?.code).toBe("space_forbidden");

    // Promote B to editor, then B can remove A's item.
    useSession(USER_A);
    await app.request(`/api/public/v1/spaces/${space.id}/members/${USER_B.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ role: "editor" }),
    });

    useSession(USER_B);
    const okRes = await app.request(`/api/public/v1/spaces/${space.id}/items/${item.id}`, { method: "DELETE" });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ removed: true, id: item.id });

    const listRes = await listItems(space.id);
    expect(((await listRes.json()) as { items: unknown[] }).items).toHaveLength(0);

    // The underlying file itself must still exist — removing a space item is a
    // reference-only delete (design §Security #5).
    const [fileRow] = await runtime.db.select().from(files).where(eq(files.id, "file-a3")).limit(1);
    expect(fileRow).toBeDefined();
    expect(fileRow.deletedAt).toBeNull();
  });

  it("a contributor can remove their OWN item without being an editor", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();
    await inviteMember(space.id, USER_B.email, "contributor");

    useSession(USER_B);
    const memRes = await app.request("/api/public/v1/memory", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "B's own note", key: "b-own" }),
    });
    const memId = ((await memRes.json()) as { memory: { id: string } }).memory.id;
    const contributeRes = await contribute(space.id, "memory", memId);
    const item = ((await contributeRes.json()) as { item: { id: string } }).item;

    const removeRes = await app.request(`/api/public/v1/spaces/${space.id}/items/${item.id}`, { method: "DELETE" });
    expect(removeRes.status).toBe(200);

    // Underlying memory must survive the reference removal.
    const [memRow] = await runtime.db.select().from(memories).where(eq(memories.id, memId)).limit(1);
    expect(memRow).toBeDefined();
  });

  it("DELETE on an unknown itemId returns 404 item_not_found", async () => {
    seedUsers();
    useSession(USER_A);
    const space = await createSpace();

    const res = await app.request(`/api/public/v1/spaces/${space.id}/items/does-not-exist`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("item_not_found");
  });

  it("viewer can list items (read access) but a non-member cannot", async () => {
    seedUsers();
    await seedDriveFile({ id: "file-a4", path: "/visible.txt", ownerId: USER_A.id });
    useSession(USER_A);
    const space = await createSpace();
    await contribute(space.id, "file", "/visible.txt");
    await inviteMember(space.id, USER_B.email, "viewer");

    useSession(USER_B);
    const okRes = await listItems(space.id);
    expect(okRes.status).toBe(200);
    expect(((await okRes.json()) as { items: unknown[] }).items).toHaveLength(1);

    useSession(USER_C);
    const forbiddenRes = await listItems(space.id);
    expect(forbiddenRes.status).toBe(403);
  });

  it("?type= filters the list to a single item type", async () => {
    seedUsers();
    await seedDriveFile({ id: "file-a5", path: "/mixed.txt", ownerId: USER_A.id });
    useSession(USER_A);
    const space = await createSpace();
    await contribute(space.id, "file", "/mixed.txt");
    const memRes = await app.request("/api/public/v1/memory", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ content: "mixed note", key: "mixed-key" }),
    });
    const memId = ((await memRes.json()) as { memory: { id: string } }).memory.id;
    await contribute(space.id, "memory", memId);

    const filesOnly = await listItems(space.id, "?type=file");
    const filesBody = (await filesOnly.json()) as { items: { itemType: string }[] };
    expect(filesBody.items).toHaveLength(1);
    expect(filesBody.items[0].itemType).toBe("file");

    const memoriesOnly = await listItems(space.id, "?type=memory");
    const memoriesBody = (await memoriesOnly.json()) as { items: { itemType: string }[] };
    expect(memoriesBody.items).toHaveLength(1);
    expect(memoriesBody.items[0].itemType).toBe("memory");
  });

  it("a folder ref resolves to the folder's own space_item entry (drill-in is a later task)", async () => {
    seedUsers();
    await seedDriveFile({ id: "file-in-folder", path: "/proj/notes.txt", ownerId: USER_A.id });
    useSession(USER_A);
    const space = await createSpace();

    const res = await contribute(space.id, "folder", "/proj");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: Record<string, unknown> };
    expect(body.item).toMatchObject({ itemType: "folder", name: "proj" });

    const listRes = await listItems(space.id);
    const listBody = (await listRes.json()) as { items: unknown[] };
    // One entry for the folder, not its descendants — folder drill-in is Task 4.
    expect(listBody.items).toHaveLength(1);
  });
});
