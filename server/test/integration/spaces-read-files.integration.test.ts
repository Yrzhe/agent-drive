import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { files, spaceItems } from "../../src/defs";
import app from "../../src/index";
import { callMcpTool } from "../../src/lib/mcp-tools";
import {
  getViaPresignedUrl,
  jsonHeaders,
  resetRuntime,
  runtime,
  seedDriveFile,
  seedOwner,
  seedSpace,
  seedSpaceItem,
  seedSpaceMember,
  useSession,
} from "./edge-runtime";

/**
 * Shared Spaces P1 Task 4 — the controlled cross-owner FILE read hole.
 * (brief: .superpowers/sdd/task-4-brief.md; design: docs/implementation/2026-07-19-shared-spaces-design.md §Read-path change)
 *
 * These are ADVERSARIAL two-owner tests. The whole point of Task 4 is to widen owner-scoped
 * file reads to ALSO surface files reachable through the caller's space memberships — WITHOUT
 * re-opening the #30 isolation hole for non-members. Every test seeds at least two owners.
 */
describe("spaces read-path union for files (P1 Task 4)", () => {
  const A = { id: "user-a", email: "alice@x.test" };
  const B = { id: "user-b", email: "bob@x.test" };
  const C = { id: "user-c", email: "carol@x.test" };

  function seedUsers(): void {
    seedOwner({ id: A.id, email: A.email });
    seedOwner({ id: B.id, email: B.email });
    seedOwner({ id: C.id, email: C.email });
  }

  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  it("member B GETs A's contributed file by id (200); non-member C is 404 (isolation holds)", async () => {
    seedUsers();
    await seedDriveFile({ id: "a-report", path: "/report.pdf", body: "A secret report", ownerId: A.id });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-report", contributedBy: A.id });

    useSession(B);
    const bRes = await app.request(`/api/public/v1/files/a-report`, { headers: jsonHeaders() });
    expect(bRes.status).toBe(200);
    expect(((await bRes.json()) as { file: { id: string } }).file.id).toBe("a-report");

    // C is not a member of the space → must see exactly the #30 isolation behaviour.
    useSession(C);
    const cRes = await app.request(`/api/public/v1/files/a-report`, { headers: jsonHeaders() });
    expect(cRes.status).toBe(404);
  });

  it("member B downloads (preview presign) A's file → bytes are A's actual object", async () => {
    seedUsers();
    await seedDriveFile({ id: "a-doc", path: "/doc.txt", body: "contributor bytes", ownerId: A.id });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-doc", contributedBy: A.id });

    useSession(B);
    const res = await app.request(`/api/public/v1/files/a-doc/preview`, { headers: jsonHeaders() });
    expect(res.status).toBe(200);
    const { downloadUrl } = (await res.json()) as { downloadUrl: string };
    const bytes = await getViaPresignedUrl(downloadUrl);
    expect(bytes ? new TextDecoder().decode(bytes) : null).toBe("contributor bytes");

    // Non-member C cannot presign A's object.
    useSession(C);
    const cRes = await app.request(`/api/public/v1/files/a-doc/preview`, { headers: jsonHeaders() });
    expect(cRes.status).toBe(404);
  });

  it("member B's recursive file list includes A's contributed file; C's does not", async () => {
    seedUsers();
    await seedDriveFile({ id: "a-shared", path: "/shared.txt", body: "x", ownerId: A.id });
    await seedDriveFile({ id: "b-own", path: "/mine.txt", body: "y", ownerId: B.id });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-shared", contributedBy: A.id });

    useSession(B);
    const bRes = await app.request(`/api/public/v1/files?path=/&recursive=true`, { headers: jsonHeaders() });
    const bIds = ((await bRes.json()) as { files: Array<{ id: string }> }).files.map((f) => f.id);
    expect(bIds).toContain("a-shared");
    expect(bIds).toContain("b-own");

    useSession(C);
    const cRes = await app.request(`/api/public/v1/files?path=/&recursive=true`, { headers: jsonHeaders() });
    const cIds = ((await cRes.json()) as { files: Array<{ id: string }> }).files.map((f) => f.id);
    expect(cIds).not.toContain("a-shared");
  });

  it("member B sees a contributed FOLDER's whole subtree (files), not just the folder row", async () => {
    seedUsers();
    await seedDriveFile({ id: "a-nested", path: "/proj/deep/file.txt", body: "nested", ownerId: A.id });
    // resolve the folder row id for /proj
    const [projFolder] = await runtime.db.select().from(files).where(eq(files.path, "/proj")).limit(1);
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "folder", itemRef: projFolder.id, contributedBy: A.id });

    useSession(B);
    // B can fetch the deep descendant file by id.
    const res = await app.request(`/api/public/v1/files/a-nested`, { headers: jsonHeaders() });
    expect(res.status).toBe(200);

    useSession(C);
    const cRes = await app.request(`/api/public/v1/files/a-nested`, { headers: jsonHeaders() });
    expect(cRes.status).toBe(404);
  });

  it("removing the space item revokes B's access (404 again)", async () => {
    seedUsers();
    await seedDriveFile({ id: "a-revoke", path: "/revoke.txt", body: "x", ownerId: A.id });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    const itemId = await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-revoke", contributedBy: A.id });

    useSession(B);
    expect((await app.request(`/api/public/v1/files/a-revoke`, { headers: jsonHeaders() })).status).toBe(200);

    // Remove the reference row directly (models the item being removed).
    await runtime.db.delete(spaceItems).where(eq(spaceItems.id, itemId));

    expect((await app.request(`/api/public/v1/files/a-revoke`, { headers: jsonHeaders() })).status).toBe(404);
  });

  it("removing the MEMBER revokes access", async () => {
    seedUsers();
    await seedDriveFile({ id: "a-member", path: "/m.txt", body: "x", ownerId: A.id });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-member", contributedBy: A.id });

    useSession(B);
    expect((await app.request(`/api/public/v1/files/a-member`, { headers: jsonHeaders() })).status).toBe(200);

    // Remove B from the space via the members endpoint (A is creator).
    useSession(A);
    const del = await app.request(`/api/public/v1/spaces/${spaceId}/members/${B.id}`, { method: "DELETE", headers: jsonHeaders() });
    expect(del.status).toBe(200);

    useSession(B);
    expect((await app.request(`/api/public/v1/files/a-member`, { headers: jsonHeaders() })).status).toBe(404);
  });

  it("WRITE paths stay owner-only: member B cannot rename/move/delete A's space file", async () => {
    seedUsers();
    await seedDriveFile({ id: "a-write", path: "/wr.txt", body: "x", ownerId: A.id });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "editor", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-write", contributedBy: A.id });

    useSession(B);
    // rename
    const rename = await app.request(`/api/public/v1/files/a-write`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "hacked.txt" }),
    });
    expect(rename.status).toBe(404);
    // delete
    const del = await app.request(`/api/public/v1/files/a-write`, { method: "DELETE", headers: jsonHeaders() });
    expect(del.status).toBe(404);

    // A's row is provably unchanged.
    const [row] = await runtime.db.select().from(files).where(eq(files.id, "a-write")).limit(1);
    expect(row.path).toBe("/wr.txt");
    expect(row.name).toBe("wr.txt");
    expect(row.deletedAt).toBeNull();
    expect(row.ownerId).toBe(A.id);
  });

  it("search widens for a member but never for a non-member", async () => {
    seedUsers();
    await seedDriveFile({ id: "a-find", path: "/findme.txt", body: "x", ownerId: A.id });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-find", contributedBy: A.id });

    useSession(B);
    const bRes = await app.request(`/api/public/v1/files/search?q=findme`, { headers: jsonHeaders() });
    const bIds = ((await bRes.json()) as { files: Array<{ id: string }> }).files.map((f) => f.id);
    expect(bIds).toContain("a-find");

    useSession(C);
    const cRes = await app.request(`/api/public/v1/files/search?q=findme`, { headers: jsonHeaders() });
    const cIds = ((await cRes.json()) as { files: Array<{ id: string }> }).files.map((f) => f.id);
    expect(cIds).not.toContain("a-find");
  });

  it("MCP read_file/list_files widen for a member, stay isolated for a non-member", async () => {
    seedUsers();
    await seedDriveFile({ id: "a-mcp", path: "/mcp.txt", body: "mcp bytes", ownerId: A.id });
    const spaceId = await seedSpace({ creatorId: A.id });
    await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
    await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-mcp", contributedBy: A.id });

    // Member B reads A's file content via MCP by its (contributor-namespace) path.
    const bRead = await callMcpTool(runtime.db as never, "https://x", ["read:drive", "path:/"], "read_file", { path: "/mcp.txt" }, B.id);
    expect(JSON.stringify(bRead)).toContain("mcp bytes");
    const bList = await callMcpTool(runtime.db as never, "https://x", ["read:drive", "path:/"], "list_files", { path: "/", recursive: true }, B.id);
    expect(JSON.stringify(bList)).toContain("/mcp.txt");

    // Non-member C is fully isolated.
    await expect(
      callMcpTool(runtime.db as never, "https://x", ["read:drive", "path:/"], "read_file", { path: "/mcp.txt" }, C.id)
    ).rejects.toThrow(/file_not_found/);
    const cList = await callMcpTool(runtime.db as never, "https://x", ["read:drive", "path:/"], "list_files", { path: "/", recursive: true }, C.id);
    expect(JSON.stringify(cList)).not.toContain("/mcp.txt");
  });
});
