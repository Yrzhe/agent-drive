import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { files, memories } from "../../src/defs";
import { callMcpTool } from "../../src/lib/mcp-tools";
import { getMemory, listMemories, recallMemories } from "../../src/lib/memory";
import { jsonHeaders, resetRuntime, runtime, seedDriveFile, seedMemory, seedOwner, useBearer } from "./edge-runtime";

describe("two-owner isolation harness (#30 Part ①a)", () => {
  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  it("seeds rows under a specific owner", async () => {
    await seedDriveFile({ id: "fa", path: "/a.txt", body: "a", ownerId: "A" });
    await seedMemory({ id: "ma", key: "ka", content: "ca", ownerId: "A" });
    const [f] = await runtime.db.select().from(files).where(eq(files.id, "fa")).limit(1);
    const [m] = await runtime.db.select().from(memories).where(eq(memories.id, "ma")).limit(1);
    expect(f?.ownerId).toBe("A");
    expect(m?.ownerId).toBe("A");
  });

  it("owner B cannot recall/list/get owner A's memory", async () => {
    seedOwner({ email: "a@x.test", id: "A" });
    await seedMemory({ id: "ma", key: "secret", content: "A's private note", ownerId: "A" });
    // list is owner-scoped:
    expect(await listMemories(runtime.db as never, 100, 0, "B")).toHaveLength(0);
    expect(await listMemories(runtime.db as never, 100, 0, "A")).toHaveLength(1);
    // recall is owner-scoped:
    expect(await recallMemories(runtime.db as never, "private", 10, "B")).toHaveLength(0);
    expect(await recallMemories(runtime.db as never, "private", 10, "A")).toHaveLength(1);
    // get by id/key is owner-scoped:
    expect(await getMemory(runtime.db as never, "ma", "B")).toBeNull();
    expect(await getMemory(runtime.db as never, "secret", "B")).toBeNull();
    expect(await getMemory(runtime.db as never, "ma", "A")).not.toBeNull();
  });

  it("a bearer token bound to owner B sees only B's files", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    await seedDriveFile({ id: "fa", path: "/a.txt", body: "x", ownerId: "A" }); // A's file
    await seedDriveFile({ id: "fb", path: "/b.txt", body: "y", ownerId: "B" }); // B's file
    const headers = jsonHeaders(useBearer(["read:drive", "path:/"]));
    const { default: app } = await import("../../src/index");
    const res = await app.request("/api/public/v1/files?path=/", { headers });
    const body = (await res.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path).sort()).toEqual(["/b.txt"]);
  });

  it("a bearer token bound to owner B cannot delete/restore/purge owner A's files by id", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    await seedDriveFile({ id: "fa", path: "/a-secret.txt", body: "x", ownerId: "A" }); // A's live file

    const trashedId = "fa-trashed";
    const trashedPath = `/a-trashed.txt${"~trash~"}${trashedId}`;
    const timestamp = new Date().toISOString();
    await runtime.db.insert(files).values({
      id: trashedId,
      name: "a-trashed.txt",
      path: trashedPath,
      parentPath: "/",
      isFolder: 0,
      size: 1,
      contentType: "text/plain",
      s3Uri: null,
      deletedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerId: "A",
    } as never); // A's trashed file

    const headers = jsonHeaders(useBearer(["read:drive", "write:drive", "path:/"]));
    const { default: app } = await import("../../src/index");

    const del = await app.request("/api/public/v1/files/fa", { method: "DELETE", headers });
    expect(del.status).toBe(404);

    const restore = await app.request(`/api/public/v1/files/${trashedId}/restore`, { method: "POST", headers });
    expect(restore.status).toBe(404);

    const purge = await app.request(`/api/public/v1/files/${trashedId}/purge`, { method: "DELETE", headers });
    expect(purge.status).toBe(404);
  });

  it("a cross-owner path collision on rename returns 409, not a raw D1 500", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    await seedDriveFile({ id: "fa", path: "/a.txt", body: "x", ownerId: "A" }); // A's file
    const bFileId = await seedDriveFile({ id: "fb", path: "/b.txt", body: "y", ownerId: "B" }); // B's file

    const headers = jsonHeaders(useBearer(["read:drive", "write:drive", "path:/"]));
    const { default: app } = await import("../../src/index");

    // B's owner-scoped path-conflict pre-check can no longer see A's row at /a.txt,
    // so the rename must be caught by the D1 unique-violation catch instead and
    // surfaced as a clean 409 — not an unhandled 500.
    const rename = await app.request(`/api/public/v1/files/${bFileId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ parentPath: "/", name: "a.txt" }),
    });
    expect(rename.status).toBe(409);
    const body = (await rename.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("path_conflict");
  });

  it("MCP list_files/search_files/read_file bound to B never surface A's files", async () => {
    await seedDriveFile({ id: "fa", path: "/a.txt", body: "aaa", ownerId: "A" });
    await seedDriveFile({ id: "fb", path: "/b.txt", body: "bbb", ownerId: "B" });
    const list = await callMcpTool(runtime.db as never, "https://x", ["read:drive", "path:/"], "list_files", { path: "/" }, "B");
    expect(JSON.stringify(list)).not.toContain("/a.txt");
    const search = await callMcpTool(runtime.db as never, "https://x", ["read:drive", "path:/"], "search_files", { query: "a.txt" }, "B");
    expect(JSON.stringify(search)).not.toContain("/a.txt");
    await expect(callMcpTool(runtime.db as never, "https://x", ["read:drive", "path:/"], "read_file", { path: "/a.txt" }, "B")).rejects.toThrow(/file_not_found/);
  });
});
