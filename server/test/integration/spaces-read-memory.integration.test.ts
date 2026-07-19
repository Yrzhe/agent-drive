import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { memories, spaceItems } from "../../src/defs";
import app from "../../src/index";
import { callMcpTool } from "../../src/lib/mcp-tools";
import {
  jsonHeaders,
  resetRuntime,
  runtime,
  seedOwner,
  seedSpace,
  seedSpaceItem,
  seedSpaceMember,
  useSession,
} from "./edge-runtime";

/**
 * Shared Spaces P1 Task 5 — the controlled cross-owner MEMORY read hole (the memory twin of
 * Task 4). (brief: .superpowers/sdd/task-5-brief.md; design §Read-path change / §Security spine)
 *
 * ADVERSARIAL two-owner tests. Task 5 widens owner-scoped memory reads (list, get, FTS recall)
 * to ALSO surface memories reachable through the caller's space memberships — WITHOUT re-opening
 * the #30 isolation hole for non-members, and WITHOUT leaking a contributor's OWN un-contributed
 * memories. Every test seeds at least two owners.
 */
describe("spaces read-path union for memory (P1 Task 5)", () => {
  const A = { id: "user-a", email: "alice@x.test" };
  const B = { id: "user-b", email: "bob@x.test" };
  const C = { id: "user-c", email: "carol@x.test" };

  function seedUsers(): void {
    seedOwner({ id: A.id, email: A.email });
    seedOwner({ id: B.id, email: B.email });
    seedOwner({ id: C.id, email: C.email });
  }

  /** Create a memory via the REAL REST endpoint as `user` (stamps ownerId + FTS index). */
  async function remember(user: { id: string; email: string }, body: Record<string, unknown>): Promise<string> {
    useSession(user);
    const res = await app.request("/api/public/v1/memory", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBeLessThan(300);
    return ((await res.json()) as { memory: { id: string } }).memory.id;
  }

  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  it("member B GETs A's contributed memory by id (200); non-member C is 404 (isolation holds)", async () => {
    seedUsers();
    const memId = await remember(A, { key: "kb-note", content: "shared kb note zephyrtoken" });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "memory", itemRef: memId, contributedBy: A.id });

    useSession(B);
    const bRes = await app.request(`/api/public/v1/memory/${memId}`, { headers: jsonHeaders() });
    expect(bRes.status).toBe(200);
    expect(((await bRes.json()) as { memory: { id: string } }).memory.id).toBe(memId);

    useSession(C);
    const cRes = await app.request(`/api/public/v1/memory/${memId}`, { headers: jsonHeaders() });
    expect(cRes.status).toBe(404);
  });

  it("member B's list includes A's contributed memory attributed; C's does not", async () => {
    seedUsers();
    const memId = await remember(A, { content: "contributed list entry" });
    await remember(B, { content: "b own entry" });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "memory", itemRef: memId, contributedBy: A.id });

    useSession(B);
    const bRes = await app.request(`/api/public/v1/memory?limit=100`, { headers: jsonHeaders() });
    const bIds = ((await bRes.json()) as { memories: Array<{ id: string }> }).memories.map((m) => m.id);
    expect(bIds).toContain(memId); // A's contributed memory
    expect(bIds.length).toBeGreaterThanOrEqual(2); // plus B's own

    useSession(C);
    const cRes = await app.request(`/api/public/v1/memory?limit=100`, { headers: jsonHeaders() });
    const cIds = ((await cRes.json()) as { memories: Array<{ id: string }> }).memories.map((m) => m.id);
    expect(cIds).not.toContain(memId);
  });

  it("member B recalls (FTS) A's contributed memory by content token; C never does", async () => {
    seedUsers();
    const memId = await remember(A, { content: "the secret ingredient is quixotictoken" });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "memory", itemRef: memId, contributedBy: A.id });

    useSession(B);
    const bRes = await app.request(`/api/public/v1/memory/search?q=quixotictoken`, { headers: jsonHeaders() });
    const bIds = ((await bRes.json()) as { memories: Array<{ id: string }> }).memories.map((m) => m.id);
    expect(bIds).toContain(memId);

    useSession(C);
    const cRes = await app.request(`/api/public/v1/memory/search?q=quixotictoken`, { headers: jsonHeaders() });
    const cBody = (await cRes.json()) as { memories: Array<{ id: string }>; count: number };
    expect(cBody.count).toBe(0);
    expect(cBody.memories.map((m) => m.id)).not.toContain(memId);
  });

  it("a contributor's OWN un-contributed private memory NEVER leaks to a member (get/list/recall)", async () => {
    seedUsers();
    const sharedId = await remember(A, { content: "shared contributed marker sharedtoken" });
    const privateId = await remember(A, { content: "A private diary privatetoken" });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    // Only the shared memory is contributed; the private one is NOT.
    await seedSpaceItem({ spaceId, itemType: "memory", itemRef: sharedId, contributedBy: A.id });

    useSession(B);
    // get: private → 404, shared → 200
    expect((await app.request(`/api/public/v1/memory/${privateId}`, { headers: jsonHeaders() })).status).toBe(404);
    expect((await app.request(`/api/public/v1/memory/${sharedId}`, { headers: jsonHeaders() })).status).toBe(200);
    // list: shared present, private absent
    const listIds = ((await (await app.request(`/api/public/v1/memory?limit=100`, { headers: jsonHeaders() })).json()) as { memories: Array<{ id: string }> }).memories.map((m) => m.id);
    expect(listIds).toContain(sharedId);
    expect(listIds).not.toContain(privateId);
    // recall for the private token → nothing
    const recall = (await (await app.request(`/api/public/v1/memory/search?q=privatetoken`, { headers: jsonHeaders() })).json()) as { memories: Array<{ id: string }> };
    expect(recall.memories.map((m) => m.id)).not.toContain(privateId);
  });

  it("removing the space item revokes B's memory access (404 again)", async () => {
    seedUsers();
    const memId = await remember(A, { content: "revocable memory revoketoken" });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    const itemId = await seedSpaceItem({ spaceId, itemType: "memory", itemRef: memId, contributedBy: A.id });

    useSession(B);
    expect((await app.request(`/api/public/v1/memory/${memId}`, { headers: jsonHeaders() })).status).toBe(200);

    await runtime.db.delete(spaceItems).where(eq(spaceItems.id, itemId));

    expect((await app.request(`/api/public/v1/memory/${memId}`, { headers: jsonHeaders() })).status).toBe(404);
    const recall = (await (await app.request(`/api/public/v1/memory/search?q=revoketoken`, { headers: jsonHeaders() })).json()) as { count: number };
    expect(recall.count).toBe(0);
  });

  it("removing the MEMBER revokes access", async () => {
    seedUsers();
    const memId = await remember(A, { content: "member scoped memory membertoken" });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "memory", itemRef: memId, contributedBy: A.id });

    useSession(B);
    expect((await app.request(`/api/public/v1/memory/${memId}`, { headers: jsonHeaders() })).status).toBe(200);

    useSession(A);
    const del = await app.request(`/api/public/v1/spaces/${spaceId}/members/${B.id}`, { method: "DELETE", headers: jsonHeaders() });
    expect(del.status).toBe(200);

    useSession(B);
    expect((await app.request(`/api/public/v1/memory/${memId}`, { headers: jsonHeaders() })).status).toBe(404);
  });

  it("WRITE paths stay owner-only: member B cannot delete or overwrite A's contributed memory", async () => {
    seedUsers();
    const memId = await remember(A, { key: "kb-shared", content: "original A content owntoken" });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "editor", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "memory", itemRef: memId, contributedBy: A.id });

    // B can READ it (member) ...
    useSession(B);
    expect((await app.request(`/api/public/v1/memory/${memId}`, { headers: jsonHeaders() })).status).toBe(200);
    // ... but DELETE is owner-scoped → 404, A's row untouched.
    const del = await app.request(`/api/public/v1/memory/${memId}`, { method: "DELETE", headers: jsonHeaders() });
    expect(del.status).toBe(404);

    // remember with A's key from B creates a SEPARATE B-owned memory; A's is not overwritten.
    const bRemember = await app.request(`/api/public/v1/memory`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ key: "kb-shared", content: "B tried to overwrite" }),
    });
    expect(bRemember.status).toBeLessThan(300);

    const [aRow] = await runtime.db.select().from(memories).where(eq(memories.id, memId)).limit(1);
    expect(aRow.content).toBe("original A content owntoken");
    expect(aRow.ownerId).toBe(A.id);
  });

  it("MCP recall/list_memories widen for a member, stay isolated for a non-member", async () => {
    seedUsers();
    const memId = await remember(A, { content: "mcp reachable memory mcptoken" });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "memory", itemRef: memId, contributedBy: A.id });

    // Member B recalls + lists A's memory via MCP.
    const bRecall = await callMcpTool(runtime.db as never, "https://x", ["read:memory"], "recall", { query: "mcptoken" }, B.id);
    expect(JSON.stringify(bRecall)).toContain(memId);
    const bList = await callMcpTool(runtime.db as never, "https://x", ["read:memory"], "list_memories", { limit: 100 }, B.id);
    expect(JSON.stringify(bList)).toContain(memId);

    // Non-member C is fully isolated.
    const cRecall = await callMcpTool(runtime.db as never, "https://x", ["read:memory"], "recall", { query: "mcptoken" }, C.id);
    expect(JSON.stringify(cRecall)).not.toContain(memId);
    const cList = await callMcpTool(runtime.db as never, "https://x", ["read:memory"], "list_memories", { limit: 100 }, C.id);
    expect(JSON.stringify(cList)).not.toContain(memId);
  });

  it("MCP forget stays owner-only: member B cannot delete A's contributed memory", async () => {
    seedUsers();
    const memId = await remember(A, { content: "forget guard forgettoken" });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "editor", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "memory", itemRef: memId, contributedBy: A.id });

    await expect(
      callMcpTool(runtime.db as never, "https://x", ["write:memory"], "forget", { id: memId }, B.id)
    ).rejects.toThrow(/memory_not_found/);

    const [aRow] = await runtime.db.select().from(memories).where(eq(memories.id, memId)).limit(1);
    expect(aRow).toBeDefined();
  });
});
