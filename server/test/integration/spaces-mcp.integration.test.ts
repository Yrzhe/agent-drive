import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { files } from "../../src/defs";
import { callMcpTool } from "../../src/lib/mcp-tools";
import {
  resetRuntime,
  runtime,
  seedDriveFile,
  seedOwner,
  seedSpace,
  seedSpaceItem,
  seedSpaceMember,
} from "./edge-runtime";

/**
 * Shared Spaces P1 Task 6 — MCP space tools + write-role enforcement.
 * (brief: .superpowers/sdd/task-6-brief.md; design: docs/implementation/2026-07-19-shared-spaces-design.md)
 *
 * ADVERSARIAL two-owner tests. The point of Task 6 is (a) agent-facing MCP tools for spaces
 * and (b) the ONE controlled cross-owner WRITE hole: an editor+ may overwrite a contributor's
 * real file reached via a space, while a contributor/viewer may not touch another member's
 * file. Every test seeds at least two distinct owners; the caller `userId` is threaded to
 * callMcpTool exactly as the MCP route does.
 */

const READ = ["read:drive", "path:/"];
const WRITE = ["write:drive", "path:/"];
const ORIGIN = "https://drive.test";

const A = { id: "user-a", email: "alice@x.test" };
const B = { id: "user-b", email: "bob@x.test" };
const C = { id: "user-c", email: "carol@x.test" };

function seedUsers(): void {
  seedOwner({ id: A.id, email: A.email });
  seedOwner({ id: B.id, email: B.email });
  seedOwner({ id: C.id, email: C.email });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => runtime.db as any;
const call = (scopes: readonly string[], name: string, input: Record<string, unknown>, userId: string | null) =>
  callMcpTool(db(), ORIGIN, scopes, name, input, userId);
const payload = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

/**
 * Assert an MCP tool call rejects with a given code. Space helpers throw ApiError (machine
 * code in `.code`, prose in `.message`); the MCP route surfaces it as `code:message`. This
 * mirrors that formatting so the assertion tests exactly what an agent sees over the wire —
 * covering both ApiError (space_forbidden, not_your_resource) and plain colon-prefixed errors.
 */
async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    expect(code ? `${code}:${message}` : message).toMatch(pattern);
    return;
  }
  throw new Error(`expected rejection matching ${pattern}`);
}

describe("spaces MCP tools (P1 Task 6)", () => {
  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  describe("list_spaces / read_space", () => {
    it("member B lists and reads the space; non-member C sees nothing / errors", async () => {
      seedUsers();
      await seedDriveFile({ id: "a-file", path: "/report.md", body: "v1", ownerId: A.id });
      const spaceId = await seedSpace({ creatorId: A.id, name: "Team KB" });
      await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
      await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-file", contributedBy: A.id });

      const bSpaces = payload(await call(READ, "list_spaces", {}, B.id)).spaces;
      expect(bSpaces).toHaveLength(1);
      expect(bSpaces[0]).toMatchObject({ id: spaceId, name: "Team KB", role: "viewer", itemCount: 1, memberCount: 2 });

      const bRead = payload(await call(READ, "read_space", { space: spaceId }, B.id));
      expect(bRead.space.role).toBe("viewer");
      expect(bRead.items.map((i: { itemRef: string }) => i.itemRef)).toContain("a-file");
      expect(bRead.items[0].contributedBy).toBe(A.id);

      // C is not a member: empty list, and read_space must not confirm the id exists.
      expect(payload(await call(READ, "list_spaces", {}, C.id)).spaces).toEqual([]);
      await rejectsWith(call(READ, "read_space", { space: spaceId }, C.id), /space_not_found/);
    });

    it("list_spaces without a user identity (legacy AGENT_TOKEN) errors", async () => {
      await rejectsWith(call(READ, "list_spaces", {}, null), /identity_required/);
    });
  });

  describe("write_file role enforcement (the cross-owner write hole)", () => {
    it("editor B overwrites A's real contributed file (D1 row + object change; still A-owned)", async () => {
      seedUsers();
      await seedDriveFile({ id: "a-team", path: "/team.md", body: "v1", ownerId: A.id });
      const spaceId = await seedSpace({ creatorId: A.id });
      await seedSpaceMember({ spaceId, userId: B.id, role: "editor", addedBy: A.id });
      await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-team", contributedBy: A.id });

      await call(WRITE, "write_file", { path: "/team.md", content: "v2 by editor B" }, B.id);

      // A's REAL row was overwritten in place — same id, still owned by A, new size. No shadow.
      const rows = await db().select().from(files).where(eq(files.path, "/team.md"));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe("a-team");
      expect(rows[0].ownerId).toBe(A.id);
      expect(rows[0].size).toBe(new TextEncoder().encode("v2 by editor B").byteLength);

      // The contributor's actual bytes changed (read back through A's own owner-scoped read).
      const aRead = payload(await call(READ, "read_file", { path: "/team.md" }, A.id));
      expect(aRead.content).toBe("v2 by editor B");
    });

    it("creator A (editor+) may overwrite a member's contributed file via the space", async () => {
      seedUsers();
      await seedDriveFile({ id: "b-doc", path: "/b.md", body: "b original", ownerId: B.id });
      const spaceId = await seedSpace({ creatorId: A.id });
      await seedSpaceMember({ spaceId, userId: B.id, role: "contributor", addedBy: A.id });
      await seedSpaceItem({ spaceId, itemType: "file", itemRef: "b-doc", contributedBy: B.id });

      await call(WRITE, "write_file", { path: "/b.md", content: "curated by creator A" }, A.id);

      const [row] = await db().select().from(files).where(eq(files.id, "b-doc")).limit(1);
      expect(row.ownerId).toBe(B.id); // still B's file
      const bRead = payload(await call(READ, "read_file", { path: "/b.md" }, B.id));
      expect(bRead.content).toBe("curated by creator A");
    });

    it("contributor B is refused (space_forbidden) and A's file is untouched, no shadow copy", async () => {
      seedUsers();
      await seedDriveFile({ id: "a-team", path: "/team.md", body: "v1", ownerId: A.id });
      const spaceId = await seedSpace({ creatorId: A.id });
      await seedSpaceMember({ spaceId, userId: B.id, role: "contributor", addedBy: A.id });
      await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-team", contributedBy: A.id });

      await rejectsWith(call(WRITE, "write_file", { path: "/team.md", content: "hax" }, B.id), /space_forbidden/);

      const rows = await db().select().from(files).where(eq(files.path, "/team.md"));
      expect(rows).toHaveLength(1); // no B-owned shadow file was forked
      expect(rows[0].ownerId).toBe(A.id);
      expect(rows[0].size).toBe(new TextEncoder().encode("v1").byteLength);
    });

    it("viewer B is refused (space_forbidden) — read access never implies write", async () => {
      seedUsers();
      await seedDriveFile({ id: "a-team", path: "/team.md", body: "v1", ownerId: A.id });
      const spaceId = await seedSpace({ creatorId: A.id });
      await seedSpaceMember({ spaceId, userId: B.id, role: "viewer", addedBy: A.id });
      await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-team", contributedBy: A.id });

      await rejectsWith(call(WRITE, "write_file", { path: "/team.md", content: "hax" }, B.id), /space_forbidden/);
    });

    it("non-member C writing the same path forks C's OWN file — A stays isolated", async () => {
      seedUsers();
      await seedDriveFile({ id: "a-team", path: "/team.md", body: "v1", ownerId: A.id });
      const spaceId = await seedSpace({ creatorId: A.id });
      await seedSpaceMember({ spaceId, userId: B.id, role: "editor", addedBy: A.id });
      await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-team", contributedBy: A.id });

      await call(WRITE, "write_file", { path: "/team.md", content: "C's own file" }, C.id);

      const rows = await db().select().from(files).where(eq(files.path, "/team.md"));
      const byOwner = Object.fromEntries(rows.map((r: { ownerId: string; id: string }) => [r.ownerId, r.id]));
      expect(byOwner[A.id]).toBe("a-team");
      expect(byOwner[C.id]).toBeDefined();
      expect(byOwner[C.id]).not.toBe("a-team");
      // A's bytes unchanged.
      const aRead = payload(await call(READ, "read_file", { path: "/team.md" }, A.id));
      expect(aRead.content).toBe("v1");
    });

    it("owner writing their OWN space file is unchanged (normal owner-scoped write)", async () => {
      seedUsers();
      await seedDriveFile({ id: "a-own", path: "/own.md", body: "one", ownerId: A.id });
      const spaceId = await seedSpace({ creatorId: A.id });
      await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-own", contributedBy: A.id });

      await call(WRITE, "write_file", { path: "/own.md", content: "two" }, A.id);
      const [row] = await db().select().from(files).where(eq(files.id, "a-own")).limit(1);
      expect(row.size).toBe(new TextEncoder().encode("two").byteLength);
      expect(row.ownerId).toBe(A.id);
    });

    it("legacy AGENT_TOKEN (null user) write is unaffected — creates a null-owned file", async () => {
      await call(WRITE, "write_file", { path: "/legacy.txt", content: "hi" }, null);
      const [row] = await db().select().from(files).where(eq(files.path, "/legacy.txt")).limit(1);
      expect(row.ownerId).toBeNull();
    });
  });

  describe("add_to_space / remove_from_space", () => {
    it("contributor adds their OWN resource; cannot contribute another owner's file", async () => {
      seedUsers();
      await seedDriveFile({ id: "a-file", path: "/a.md", body: "a", ownerId: A.id });
      await seedDriveFile({ id: "b-file", path: "/b.md", body: "b", ownerId: B.id });
      const spaceId = await seedSpace({ creatorId: A.id });
      await seedSpaceMember({ spaceId, userId: B.id, role: "contributor", addedBy: A.id });

      const added = payload(await call(WRITE, "add_to_space", { space: spaceId, type: "file", path: "/b.md" }, B.id));
      expect(added.item).toMatchObject({ itemRef: "b-file", contributedBy: B.id });

      // B cannot expose A's file (does not own it) — same error as "no such resource".
      await rejectsWith(call(WRITE, "add_to_space", { space: spaceId, type: "file", path: "/a.md" }, B.id), /not_your_resource/);

      // A non-member cannot add at all.
      await seedDriveFile({ id: "c-file", path: "/c.md", body: "c", ownerId: C.id });
      await rejectsWith(call(WRITE, "add_to_space", { space: spaceId, type: "file", path: "/c.md" }, C.id), /space_forbidden/);
    });

    it("contributor removes only their own item; editor removes anyone's", async () => {
      seedUsers();
      await seedDriveFile({ id: "a-file", path: "/a.md", body: "a", ownerId: A.id });
      const spaceId = await seedSpace({ creatorId: A.id });
      await seedSpaceMember({ spaceId, userId: B.id, role: "contributor", addedBy: A.id });
      const aItem = await seedSpaceItem({ spaceId, itemType: "file", itemRef: "a-file", contributedBy: A.id });

      // B (contributor) cannot remove A's item.
      await rejectsWith(call(WRITE, "remove_from_space", { space: spaceId, item_id: aItem }, B.id), /space_forbidden/);

      // Promote B to editor (direct seed of an editor member on a fresh item) and retry.
      await seedDriveFile({ id: "b-file", path: "/b.md", body: "b", ownerId: B.id });
      const bItem = await seedSpaceItem({ spaceId, itemType: "file", itemRef: "b-file", contributedBy: B.id });
      // B removes their OWN item as a contributor — allowed.
      const removed = payload(await call(WRITE, "remove_from_space", { space: spaceId, item_id: bItem }, B.id));
      expect(removed).toMatchObject({ removed: true, id: bItem });
    });
  });

  describe("create_space / manage_space_members", () => {
    it("A creates a space, invites B as editor, then removes B — B's view tracks it", async () => {
      seedUsers();
      const created = payload(await call(WRITE, "create_space", { name: "MCP Space" }, A.id));
      const spaceId = created.space.id;
      expect(created.space).toMatchObject({ role: "creator", name: "MCP Space", visibility: "invite" });

      // Before invite, B sees nothing.
      expect(payload(await call(READ, "list_spaces", {}, B.id)).spaces).toEqual([]);

      const invited = payload(await call(WRITE, "manage_space_members", { space: spaceId, email: B.email, role: "editor" }, A.id));
      expect(invited.member).toMatchObject({ userId: B.id, role: "editor" });

      const bSpaces = payload(await call(READ, "list_spaces", {}, B.id)).spaces;
      expect(bSpaces).toHaveLength(1);
      expect(bSpaces[0]).toMatchObject({ id: spaceId, role: "editor" });

      // A non-creator cannot manage members.
      await rejectsWith(call(WRITE, "manage_space_members", { space: spaceId, email: C.email, role: "viewer" }, B.id), /space_forbidden/);

      // Remove B.
      const removed = payload(await call(WRITE, "manage_space_members", { space: spaceId, email: B.email, remove: true }, A.id));
      expect(removed).toMatchObject({ removed: true, userId: B.id });
      expect(payload(await call(READ, "list_spaces", {}, B.id)).spaces).toEqual([]);
    });

    it("create_space without a user identity errors", async () => {
      await rejectsWith(call(WRITE, "create_space", { name: "x" }, null), /identity_required/);
    });
  });
});
