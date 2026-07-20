import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { files, spaces, userAccess } from "../../src/defs";
import app from "../../src/index";
import type { AccessStatus } from "../../src/lib/access";
import { nowIso } from "../../src/lib/files";
import { callMcpTool } from "../../src/lib/mcp-tools";
import { accessibleFileIds, ensurePublicCommons, userSpaceIds } from "../../src/lib/spaces";
import {
  getViaPresignedUrl,
  jsonHeaders,
  resetRuntime,
  runtime,
  seedDriveFile,
  seedMemory,
  seedOwner,
  seedSpace,
  seedSpaceMember,
  useSession,
} from "./edge-runtime";

/**
 * Shared Spaces P2 Task 2 — the public commons ACCESS surface, adversarially.
 * (plan: docs/implementation/2026-07-20-shared-spaces-P2-PLAN.md)
 *
 * Task 1 made every ACTIVE user an implicit `contributor` of the ONE `visibility='public'`
 * space. That is a real widening of the #30 isolation boundary, so this suite exists to prove
 * exactly how far it goes and — more importantly — where it STOPS:
 *
 *  - the commons widens reads to CONTRIBUTED items only (never a contributor's other files),
 *  - the implicit role is contributor and never editor (no cross-user remove/overwrite),
 *  - only the contributor (withdraw) or the commons creator (moderate) may remove an item,
 *  - a suspended user gets nothing at all,
 *  - an EMPTY commons leaves the strict owner filter byte-for-byte intact.
 */
describe("public commons access + moderation (P2 Task 2)", () => {
  const OWNER = { id: "owner-user", email: "owner@x.test" };
  const A = { id: "user-a", email: "alice@x.test" };
  const B = { id: "user-b", email: "bob@x.test" };
  const C = { id: "user-c", email: "carol@x.test" };

  /** Arm the single-owner boundary so the access gate is live and the owner resolves. */
  function armOwner(): void {
    seedOwner({ id: OWNER.id, email: OWNER.email });
    seedOwner({ id: A.id, email: A.email });
    seedOwner({ id: B.id, email: B.email });
    seedOwner({ id: C.id, email: C.email });
    runtime.vars.set("OWNER_EMAIL", OWNER.email);
  }

  async function setAccess(userId: string, status: AccessStatus): Promise<void> {
    await runtime.db
      .insert(userAccess)
      .values({ userId, status, appliedAt: nowIso() } as never)
      .onConflictDoUpdate({ target: userAccess.userId, set: { status } });
  }

  /** A + B active, C suspended — the cast every adversarial scenario below uses. */
  async function seedCast(): Promise<void> {
    armOwner();
    await setAccess(A.id, "active");
    await setAccess(B.id, "active");
    await setAccess(C.id, "suspended");
  }

  async function commons(): Promise<string> {
    const id = await ensurePublicCommons(runtime.db as never);
    if (!id) throw new Error("commons was not bootstrapped");
    return id;
  }

  async function contribute(spaceId: string, itemType: string, ref: string): Promise<Response> {
    return app.request(`/api/public/v1/spaces/${spaceId}/items`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ itemType, ref }),
    });
  }

  async function listItems(spaceId: string): Promise<Array<{ id: string; itemRef: string; contributedBy: string }>> {
    const res = await app.request(`/api/public/v1/spaces/${spaceId}/items`, { headers: jsonHeaders() });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ id: string; itemRef: string; contributedBy: string }> }).items;
  }

  async function errorCode(res: Response): Promise<string> {
    return ((await res.json()) as { error: { code: string } }).error.code;
  }

  /** The JSON payload an MCP tool returns, unwrapped from its `content[0].text` envelope. */
  function mcpJson(result: unknown): unknown {
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    return JSON.parse(text);
  }

  /**
   * Assert an MCP tool call fails with `code`. MCP tools signal failures as plain `Error`s
   * with a `code:message` string, but the shared spaces helpers throw the REST `ApiError`
   * (whose `code` lives on the object, not in the message) — accept either shape rather than
   * asserting on one surface's formatting.
   */
  async function expectMcpError(call: Promise<unknown>, code: string): Promise<void> {
    const error = await call.then(
      () => null,
      (thrown: unknown) => thrown
    );
    expect(error).not.toBeNull();
    const thrownCode = (error as { code?: string }).code ?? "";
    const message = (error as Error).message ?? "";
    expect(thrownCode === code || message.startsWith(`${code}:`)).toBe(true);
  }

  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  describe("discovery — GET /v1/spaces bootstraps and lists the commons", () => {
    it("lists the commons (visibility 'public') for an active caller even when nothing bootstrapped it yet", async () => {
      await seedCast();

      useSession(A);
      const res = await app.request(`/api/public/v1/spaces`, { headers: jsonHeaders() });
      expect(res.status).toBe(200);
      const { spaces: listed } = (await res.json()) as {
        spaces: Array<{ id: string; visibility: string; role: string }>;
      };

      const commonsEntry = listed.find((space) => space.visibility === "public");
      expect(commonsEntry).toBeDefined();
      expect(commonsEntry!.role).toBe("contributor");

      // The route — not any read filter — is what materialized it.
      const publicRows = await runtime.db.select({ id: spaces.id }).from(spaces).where(eq(spaces.visibility, "public"));
      expect(publicRows).toHaveLength(1);
    });

    it("lists the commons alongside the caller's own invite spaces", async () => {
      await seedCast();
      const own = await seedSpace({ creatorId: A.id, name: "A's space" });

      useSession(A);
      const res = await app.request(`/api/public/v1/spaces`, { headers: jsonHeaders() });
      const { spaces: listed } = (await res.json()) as { spaces: Array<{ id: string; visibility: string }> };

      expect(listed.map((space) => space.visibility).sort()).toEqual(["invite", "public"]);
      expect(listed.map((space) => space.id)).toContain(own);
    });

    it("MCP list_spaces also bootstraps and returns the commons", async () => {
      await seedCast();

      const result = (await callMcpTool(runtime.db as never, "https://x", ["read:drive", "path:/"], "list_spaces", {}, A.id)) as unknown;
      const { spaces: listed } = mcpJson(result) as { spaces: Array<{ visibility: string; role: string }> };
      const commonsEntry = listed.find((space) => space.visibility === "public");
      expect(commonsEntry).toBeDefined();
      expect(commonsEntry!.role).toBe("contributor");

      const publicRows = await runtime.db.select({ id: spaces.id }).from(spaces).where(eq(spaces.visibility, "public"));
      expect(publicRows).toHaveLength(1);
    });

    it("GET /v1/spaces/:commonsId and /items are readable by any active user", async () => {
      await seedCast();
      const commonsId = await commons();

      useSession(B);
      const detail = await app.request(`/api/public/v1/spaces/${commonsId}`, { headers: jsonHeaders() });
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as { space: { visibility: string } }).space.visibility).toBe("public");

      const items = await app.request(`/api/public/v1/spaces/${commonsId}/items`, { headers: jsonHeaders() });
      expect(items.status).toBe(200);
    });
  });

  describe("scenario 1 — A contributes, B reads and downloads, C (suspended) gets nothing", () => {
    it("B reads + downloads A's commons file; C is denied by the access gate", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-shared", path: "/shared.txt", body: "commons bytes", ownerId: A.id });

      useSession(A);
      expect((await contribute(commonsId, "file", "/shared.txt")).status).toBe(201);

      useSession(B);
      const read = await app.request(`/api/public/v1/files/a-shared`, { headers: jsonHeaders() });
      expect(read.status).toBe(200);

      const preview = await app.request(`/api/public/v1/files/a-shared/preview`, { headers: jsonHeaders() });
      expect(preview.status).toBe(200);
      const { downloadUrl } = (await preview.json()) as { downloadUrl: string };
      const bytes = await getViaPresignedUrl(downloadUrl);
      expect(bytes ? new TextDecoder().decode(bytes) : null).toBe("commons bytes");

      // C is suspended: the gate denies before any space/read resolution runs.
      useSession(C);
      const cRead = await app.request(`/api/public/v1/files/a-shared`, { headers: jsonHeaders() });
      expect(cRead.status).toBe(403);
      expect(await errorCode(cRead)).toBe("access_suspended");

      const cSpaces = await app.request(`/api/public/v1/spaces`, { headers: jsonHeaders() });
      expect(cSpaces.status).toBe(403);
      expect(await errorCode(cSpaces)).toBe("access_suspended");
    });

    it("a contributed MEMORY is recallable by B and denied to C", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedMemory({ id: "a-mem", key: "commons-note", content: "commonstoken knowledge", ownerId: A.id });

      useSession(A);
      expect((await contribute(commonsId, "memory", "commons-note")).status).toBe(201);

      useSession(B);
      expect((await app.request(`/api/public/v1/memory/a-mem`, { headers: jsonHeaders() })).status).toBe(200);
      const recall = await app.request(`/api/public/v1/memory/search?q=commonstoken`, { headers: jsonHeaders() });
      expect(recall.status).toBe(200);
      expect(((await recall.json()) as { memories: Array<{ id: string }> }).memories.map((m) => m.id)).toContain("a-mem");

      useSession(C);
      expect((await app.request(`/api/public/v1/memory/a-mem`, { headers: jsonHeaders() })).status).toBe(403);
      const cRecall = await app.request(`/api/public/v1/memory/search?q=commonstoken`, { headers: jsonHeaders() });
      expect(cRecall.status).toBe(403);
    });
  });

  describe("scenario 2 — the implicit role is contributor, NEVER editor", () => {
    it("B cannot remove A's commons item (space_forbidden) and the item survives", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-item", path: "/a-item.txt", body: "x", ownerId: A.id });

      useSession(A);
      await contribute(commonsId, "file", "/a-item.txt");
      const [item] = await listItems(commonsId);

      useSession(B);
      const res = await app.request(`/api/public/v1/spaces/${commonsId}/items/${item.id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("space_forbidden");
      expect(await listItems(commonsId)).toHaveLength(1);

      // MCP parity.
      await expectMcpError(
        callMcpTool(
          runtime.db as never,
          "https://x",
          ["write:drive", "path:/"],
          "remove_from_space",
          { space: commonsId, item_id: item.id },
          B.id
        ),
        "space_forbidden"
      );
    });

    it("B cannot OVERWRITE A's commons file through the space", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-overwrite", path: "/overwrite.txt", body: "original", ownerId: A.id });

      useSession(A);
      await contribute(commonsId, "file", "/overwrite.txt");

      await expectMcpError(
        callMcpTool(
          runtime.db as never,
          "https://x",
          ["write:drive", "path:/"],
          "write_file",
          { path: "/overwrite.txt", content: "hacked", overwrite: true },
          B.id
        ),
        "space_forbidden"
      );

      const [row] = await runtime.db.select().from(files).where(eq(files.id, "a-overwrite")).limit(1);
      expect(row.ownerId).toBe(A.id);

      // And the bytes B can read back are still A's.
      useSession(B);
      const preview = await app.request(`/api/public/v1/files/a-overwrite/preview`, { headers: jsonHeaders() });
      const { downloadUrl } = (await preview.json()) as { downloadUrl: string };
      const bytes = await getViaPresignedUrl(downloadUrl);
      expect(bytes ? new TextDecoder().decode(bytes) : null).toBe("original");
    });

    it("B cannot rename or delete A's commons file (write paths stay owner-only)", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-write", path: "/wr.txt", body: "x", ownerId: A.id });

      useSession(A);
      await contribute(commonsId, "file", "/wr.txt");

      useSession(B);
      const rename = await app.request(`/api/public/v1/files/a-write`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "hacked.txt" }),
      });
      expect(rename.status).toBe(404);
      const del = await app.request(`/api/public/v1/files/a-write`, { method: "DELETE", headers: jsonHeaders() });
      expect(del.status).toBe(404);

      const [row] = await runtime.db.select().from(files).where(eq(files.id, "a-write")).limit(1);
      expect(row.name).toBe("wr.txt");
      expect(row.deletedAt).toBeNull();
    });
  });

  describe("scenario 3 — THE boundary: only CONTRIBUTED items are widened", () => {
    it("A's non-contributed files and memory stay invisible to B", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-public", path: "/public.txt", body: "shared", ownerId: A.id });
      await seedDriveFile({ id: "a-private", path: "/private.txt", body: "secret", ownerId: A.id });
      await seedDriveFile({ id: "a-nested", path: "/vault/deep.txt", body: "deep secret", ownerId: A.id });
      await seedMemory({ id: "a-mem-pub", key: "pub-note", content: "sharedtoken knowledge", ownerId: A.id });
      await seedMemory({ id: "a-mem-priv", key: "priv-note", content: "sharedtoken secret knowledge", ownerId: A.id });

      useSession(A);
      expect((await contribute(commonsId, "file", "/public.txt")).status).toBe(201);
      expect((await contribute(commonsId, "memory", "pub-note")).status).toBe(201);

      useSession(B);
      // Contributed → visible.
      expect((await app.request(`/api/public/v1/files/a-public`, { headers: jsonHeaders() })).status).toBe(200);

      // NOT contributed → invisible by id, by preview, in listings, and in search.
      expect((await app.request(`/api/public/v1/files/a-private`, { headers: jsonHeaders() })).status).toBe(404);
      expect((await app.request(`/api/public/v1/files/a-nested`, { headers: jsonHeaders() })).status).toBe(404);
      expect((await app.request(`/api/public/v1/files/a-private/preview`, { headers: jsonHeaders() })).status).toBe(404);

      const list = await app.request(`/api/public/v1/files?path=/&recursive=true`, { headers: jsonHeaders() });
      const listedIds = ((await list.json()) as { files: Array<{ id: string }> }).files.map((f) => f.id);
      expect(listedIds).toContain("a-public");
      expect(listedIds).not.toContain("a-private");
      expect(listedIds).not.toContain("a-nested");

      const search = await app.request(`/api/public/v1/files/search?q=private`, { headers: jsonHeaders() });
      const foundIds = ((await search.json()) as { files: Array<{ id: string }> }).files.map((f) => f.id);
      expect(foundIds).not.toContain("a-private");

      // Memory: the contributed one only. Both memories match the same FTS token, so a
      // widening bug would surface the private one right next to the shared one.
      expect((await app.request(`/api/public/v1/memory/a-mem-pub`, { headers: jsonHeaders() })).status).toBe(200);
      expect((await app.request(`/api/public/v1/memory/a-mem-priv`, { headers: jsonHeaders() })).status).toBe(404);

      const recall = await app.request(`/api/public/v1/memory/search?q=sharedtoken`, { headers: jsonHeaders() });
      const recalledIds = ((await recall.json()) as { memories: Array<{ id: string }> }).memories.map((m) => m.id);
      expect(recalledIds).toContain("a-mem-pub");
      expect(recalledIds).not.toContain("a-mem-priv");

      // MCP parity — the same boundary through the agent surface.
      const mcpList = await callMcpTool(
        runtime.db as never,
        "https://x",
        ["read:drive", "path:/"],
        "list_files",
        { path: "/", recursive: true },
        B.id
      );
      expect(JSON.stringify(mcpList)).toContain("/public.txt");
      expect(JSON.stringify(mcpList)).not.toContain("/private.txt");
      await expect(
        callMcpTool(runtime.db as never, "https://x", ["read:drive", "path:/"], "read_file", { path: "/private.txt" }, B.id)
      ).rejects.toThrow(/file_not_found/);
    });

    it("contributing one file never exposes its sibling folder subtree", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-in-folder", path: "/proj/shared.txt", body: "x", ownerId: A.id });
      await seedDriveFile({ id: "a-sibling", path: "/proj/secret.txt", body: "y", ownerId: A.id });

      useSession(A);
      expect((await contribute(commonsId, "file", "/proj/shared.txt")).status).toBe(201);

      useSession(B);
      expect((await app.request(`/api/public/v1/files/a-in-folder`, { headers: jsonHeaders() })).status).toBe(200);
      expect((await app.request(`/api/public/v1/files/a-sibling`, { headers: jsonHeaders() })).status).toBe(404);
    });
  });

  describe("scenario 4 — a contributor can withdraw their own item", () => {
    it("A withdraws; B loses access immediately", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-withdraw", path: "/withdraw.txt", body: "x", ownerId: A.id });

      useSession(A);
      await contribute(commonsId, "file", "/withdraw.txt");
      const [item] = await listItems(commonsId);

      useSession(B);
      expect((await app.request(`/api/public/v1/files/a-withdraw`, { headers: jsonHeaders() })).status).toBe(200);

      useSession(A);
      const res = await app.request(`/api/public/v1/spaces/${commonsId}/items/${item.id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      });
      expect(res.status).toBe(200);

      useSession(B);
      expect((await app.request(`/api/public/v1/files/a-withdraw`, { headers: jsonHeaders() })).status).toBe(404);

      // Withdrawing is a reference-row removal only — A still owns the file.
      const [row] = await runtime.db.select().from(files).where(eq(files.id, "a-withdraw")).limit(1);
      expect(row.deletedAt).toBeNull();
      useSession(A);
      expect((await app.request(`/api/public/v1/files/a-withdraw`, { headers: jsonHeaders() })).status).toBe(200);
    });
  });

  describe("scenario 5 — the commons creator moderates", () => {
    it("the owner removes B's item; B then loses the ability to share it", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "b-item", path: "/b-item.txt", body: "x", ownerId: B.id });

      useSession(B);
      expect((await contribute(commonsId, "file", "/b-item.txt")).status).toBe(201);
      const [item] = await listItems(commonsId);
      expect(item.contributedBy).toBe(B.id);

      useSession(A);
      expect((await app.request(`/api/public/v1/files/b-item`, { headers: jsonHeaders() })).status).toBe(200);

      useSession(OWNER);
      const res = await app.request(`/api/public/v1/spaces/${commonsId}/items/${item.id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      });
      expect(res.status).toBe(200);

      useSession(A);
      expect((await app.request(`/api/public/v1/files/b-item`, { headers: jsonHeaders() })).status).toBe(404);

      // B's underlying file is untouched.
      const [row] = await runtime.db.select().from(files).where(eq(files.id, "b-item")).limit(1);
      expect(row.deletedAt).toBeNull();
      expect(row.ownerId).toBe(B.id);
    });
  });

  describe("scenario 6 — #30 isolation with an EMPTY commons", () => {
    it("an active user with no spaces still sees ONLY their own rows", async () => {
      await seedCast();
      await commons(); // exists, but empty
      await seedDriveFile({ id: "a-own", path: "/a.txt", body: "a", ownerId: A.id });
      await seedDriveFile({ id: "b-own", path: "/b.txt", body: "b", ownerId: B.id });
      await seedMemory({ id: "a-m", key: "a-key", content: "isolationtoken alpha", ownerId: A.id });
      await seedMemory({ id: "b-m", key: "b-key", content: "isolationtoken beta", ownerId: B.id });

      useSession(B);
      const list = await app.request(`/api/public/v1/files?path=/&recursive=true`, { headers: jsonHeaders() });
      const ids = ((await list.json()) as { files: Array<{ id: string }> }).files.map((f) => f.id);
      expect(ids).toEqual(["b-own"]);

      expect((await app.request(`/api/public/v1/files/a-own`, { headers: jsonHeaders() })).status).toBe(404);

      const recall = await app.request(`/api/public/v1/memory/search?q=isolationtoken`, { headers: jsonHeaders() });
      const recalledIds = ((await recall.json()) as { memories: Array<{ id: string }> }).memories.map((m) => m.id);
      expect(recalledIds).toEqual(["b-m"]);
    });
  });

  describe("D3/D4 invariants on the commons", () => {
    it("D4: a folder cannot be contributed to the commons", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-doc", path: "/proj/doc.txt", body: "x", ownerId: A.id });

      useSession(A);
      const res = await contribute(commonsId, "folder", "/proj");
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("folders_not_allowed_in_public");
    });

    it("D4 via MCP add_to_space too", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-doc", path: "/proj/doc.txt", body: "x", ownerId: A.id });

      await expectMcpError(
        callMcpTool(
          runtime.db as never,
          "https://x",
          ["write:drive", "path:/"],
          "add_to_space",
          { space: commonsId, type: "folder", path: "/proj" },
          A.id
        ),
        "folders_not_allowed_in_public"
      );
    });

    it("D3: POST /spaces cannot create a public space — visibility is forced to 'invite'", async () => {
      await seedCast();

      useSession(A);
      const res = await app.request(`/api/public/v1/spaces`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "Sneaky", visibility: "public" }),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { space: { visibility: string } }).space.visibility).toBe("invite");

      // MCP create_space likewise.
      const mcp = (await callMcpTool(
        runtime.db as never,
        "https://x",
        ["write:drive", "path:/"],
        "create_space",
        { name: "Sneaky MCP", visibility: "public" },
        A.id
      )) as unknown;
      expect((mcpJson(mcp) as { space: { visibility: string } }).space.visibility).toBe("invite");

      const publicRows = await runtime.db.select({ id: spaces.id }).from(spaces).where(eq(spaces.visibility, "public"));
      expect(publicRows.length).toBeLessThanOrEqual(1);
    });

    it("A cannot contribute a resource they do not own to the commons", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "b-secret", path: "/b-secret.txt", body: "x", ownerId: B.id });

      useSession(A);
      const res = await contribute(commonsId, "file", "/b-secret.txt");
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("not_your_resource");
    });
  });

  /**
   * Adversarial-review regressions. Each block below pins a hole the review found in the
   * first cut of P2 — they are the cases the original six scenarios did NOT cover.
   */
  describe("review regression — moderation removes the REFERENCE, never the bytes", () => {
    /** The bytes currently stored for `fileId`, read back through the caller's own preview. */
    async function readBytes(fileId: string): Promise<string | null> {
      const preview = await app.request(`/api/public/v1/files/${fileId}/preview`, { headers: jsonHeaders() });
      if (preview.status !== 200) return null;
      const { downloadUrl } = (await preview.json()) as { downloadUrl: string };
      const bytes = await getViaPresignedUrl(downloadUrl);
      return bytes ? new TextDecoder().decode(bytes) : null;
    }

    it("the OWNER cannot write_file into a contributor's commons file — but can still moderate it", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-commons", path: "/a-commons.txt", body: "alice bytes", ownerId: A.id });

      useSession(A);
      expect((await contribute(commonsId, "file", "/a-commons.txt")).status).toBe(201);
      const [item] = await listItems(commonsId);

      // The commons' creator IS the deployment owner, so a `creatorId`-based editor set would
      // make every file anyone publishes to the commons owner-writable in place. Publishing
      // is consent to be READ, never consent to have your bytes replaced at your own key.
      await expectMcpError(
        callMcpTool(
          runtime.db as never,
          "https://x",
          ["write:drive", "path:/"],
          "write_file",
          { path: "/a-commons.txt", content: "owner overwrote this", overwrite: true },
          OWNER.id
        ),
        "space_forbidden"
      );

      const [row] = await runtime.db.select().from(files).where(eq(files.id, "a-commons")).limit(1);
      expect(row.ownerId).toBe(A.id);
      expect(row.size).toBe("alice bytes".length);
      useSession(A);
      expect(await readBytes("a-commons")).toBe("alice bytes");

      // Moderation still works — it removes the REFERENCE row, not the resource.
      useSession(OWNER);
      const removed = await app.request(`/api/public/v1/spaces/${commonsId}/items/${item.id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      });
      expect(removed.status).toBe(200);
      expect(await listItems(commonsId)).toHaveLength(0);

      useSession(A);
      expect(await readBytes("a-commons")).toBe("alice bytes");
    });

    it("an owner-granted `editor` row on the commons still cannot write bytes (it moderates only)", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-modded", path: "/a-modded.txt", body: "alice bytes", ownerId: A.id });

      useSession(A);
      await contribute(commonsId, "file", "/a-modded.txt");
      const [item] = await listItems(commonsId);

      // The owner deputizes B as a commons moderator.
      await seedSpaceMember({ spaceId: commonsId, userId: B.id, role: "editor", addedBy: OWNER.id });

      await expectMcpError(
        callMcpTool(
          runtime.db as never,
          "https://x",
          ["write:drive", "path:/"],
          "write_file",
          { path: "/a-modded.txt", content: "moderator overwrote this", overwrite: true },
          B.id
        ),
        "space_forbidden"
      );
      useSession(A);
      expect(await readBytes("a-modded")).toBe("alice bytes");

      // …but B CAN remove the item, which is what the editor grant is for on a public space.
      useSession(B);
      const res = await app.request(`/api/public/v1/spaces/${commonsId}/items/${item.id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      });
      expect(res.status).toBe(200);
    });

    it("live-reference byte editing still works in an INVITE space (the power P2 did not remove)", async () => {
      await seedCast();
      const inviteSpace = await seedSpace({ creatorId: A.id, name: "Invite" });
      await seedDriveFile({ id: "a-invite", path: "/invite.txt", body: "original", ownerId: A.id });
      await seedSpaceMember({ spaceId: inviteSpace, userId: B.id, role: "editor", addedBy: A.id });

      useSession(A);
      expect((await contribute(inviteSpace, "file", "/invite.txt")).status).toBe(201);

      await callMcpTool(
        runtime.db as never,
        "https://x",
        ["write:drive", "path:/"],
        "write_file",
        { path: "/invite.txt", content: "edited by editor", overwrite: true },
        B.id
      );

      const [row] = await runtime.db.select().from(files).where(eq(files.id, "a-invite")).limit(1);
      expect(row.ownerId).toBe(A.id); // still A's file, edited in place
      useSession(A);
      expect(await readBytes("a-invite")).toBe("edited by editor");
    });
  });

  describe("review regression — the active check gates the commons uniformly", () => {
    it("a SUSPENDED user holding an explicit commons row still gets nothing", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-pub", path: "/pub.txt", body: "x", ownerId: A.id });

      useSession(A);
      expect((await contribute(commonsId, "file", "/pub.txt")).status).toBe(201);

      // C is suspended but somebody left an explicit membership row behind.
      await seedSpaceMember({ spaceId: commonsId, userId: C.id, role: "contributor", addedBy: OWNER.id });

      // `userSpaceIds` must agree with `resolveSpaceRole` (which returns null for C) — an
      // explicit row must not smuggle the commons past the active check.
      expect(await userSpaceIds(runtime.db as never, C.id)).not.toContain(commonsId);
      expect(await accessibleFileIds(runtime.db as never, C.id)).toEqual([]);

      // A is active with no row — unchanged.
      expect(await userSpaceIds(runtime.db as never, A.id)).toContain(commonsId);
    });
  });

  describe("review regression — the owner can demote a commons user without suspending them", () => {
    it("a stored `viewer` row makes A read-only in the commons; removing it restores contribute", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedDriveFile({ id: "a-spam", path: "/spam.txt", body: "x", ownerId: A.id });

      useSession(OWNER);
      const demote = await app.request(`/api/public/v1/spaces/${commonsId}/members`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ email: A.email, role: "viewer" }),
      });
      expect(demote.status).toBe(201);

      // A still READS the commons…
      useSession(A);
      expect((await app.request(`/api/public/v1/spaces/${commonsId}`, { headers: jsonHeaders() })).status).toBe(200);
      expect((await app.request(`/api/public/v1/spaces/${commonsId}/items`, { headers: jsonHeaders() })).status).toBe(200);

      // …but can no longer contribute.
      const blocked = await contribute(commonsId, "file", "/spam.txt");
      expect(blocked.status).toBe(403);
      expect(await errorCode(blocked)).toBe("space_forbidden");

      // Demotion is reversible: dropping the row restores the implicit contributor floor.
      useSession(OWNER);
      const restore = await app.request(`/api/public/v1/spaces/${commonsId}/members/${A.id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      });
      expect(restore.status).toBe(200);

      useSession(A);
      expect((await contribute(commonsId, "file", "/spam.txt")).status).toBe(201);
    });
  });

  describe("review regression — the commons member list is creator-only", () => {
    it("a non-creator active user is refused; the creator still sees it", async () => {
      await seedCast();
      const commonsId = await commons();

      // Implicit membership satisfies `viewer` for everyone, so a plain role check would hand
      // the handler's email join — including the owner's login email — to the whole drive.
      useSession(B);
      const res = await app.request(`/api/public/v1/spaces/${commonsId}/members`, { headers: jsonHeaders() });
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("space_forbidden");

      useSession(OWNER);
      const ok = await app.request(`/api/public/v1/spaces/${commonsId}/members`, { headers: jsonHeaders() });
      expect(ok.status).toBe(200);
    });

    it("invite spaces are unchanged: a viewer member still lists members", async () => {
      await seedCast();
      const inviteSpace = await seedSpace({ creatorId: A.id, name: "Invite" });
      await seedSpaceMember({ spaceId: inviteSpace, userId: B.id, role: "viewer", addedBy: A.id });

      useSession(B);
      const res = await app.request(`/api/public/v1/spaces/${inviteSpace}/members`, { headers: jsonHeaders() });
      expect(res.status).toBe(200);
      const { members } = (await res.json()) as { members: Array<{ userId: string }> };
      expect(members.map((m) => m.userId).sort()).toEqual([A.id, B.id].sort());
    });
  });

  describe("review regression — memberCount does not understate the commons audience", () => {
    it("the commons reports memberCount null; an invite space still reports a number", async () => {
      await seedCast();
      const commonsId = await commons();
      await seedSpace({ id: "invite-1", creatorId: A.id, name: "Invite" });
      await seedSpaceMember({ spaceId: "invite-1", userId: B.id, role: "viewer", addedBy: A.id });

      useSession(A);
      const res = await app.request(`/api/public/v1/spaces`, { headers: jsonHeaders() });
      const { spaces: listed } = (await res.json()) as {
        spaces: Array<{ id: string; visibility: string; memberCount: number | null }>;
      };

      // The commons is the space EVERYONE can read; `1` (its zero member rows + the creator)
      // would read as the smallest audience at exactly the publish decision point.
      expect(listed.find((space) => space.id === commonsId)!.memberCount).toBeNull();
      expect(listed.find((space) => space.id === "invite-1")!.memberCount).toBe(2);

      const detail = await app.request(`/api/public/v1/spaces/${commonsId}`, { headers: jsonHeaders() });
      expect(((await detail.json()) as { space: { memberCount: number | null } }).space.memberCount).toBeNull();

      // MCP parity.
      const mcp = await callMcpTool(runtime.db as never, "https://x", ["read:drive", "path:/"], "read_space", { space: commonsId }, A.id);
      expect((mcpJson(mcp) as { space: { memberCount: number | null } }).space.memberCount).toBeNull();
    });
  });

  describe("member management on the commons", () => {
    it("stays creator-only: an implicit member cannot invite or remove anyone", async () => {
      await seedCast();
      const commonsId = await commons();

      useSession(B);
      const add = await app.request(`/api/public/v1/spaces/${commonsId}/members`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ email: C.email, role: "editor" }),
      });
      expect(add.status).toBe(403);
      expect(await errorCode(add)).toBe("space_forbidden");

      const remove = await app.request(`/api/public/v1/spaces/${commonsId}/members/${A.id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      });
      expect(remove.status).toBe(403);

      const del = await app.request(`/api/public/v1/spaces/${commonsId}`, { method: "DELETE", headers: jsonHeaders() });
      expect(del.status).toBe(403);
    });

    it("there are no implicit member ROWS: the owner removing an implicit member 404s cleanly", async () => {
      await seedCast();
      const commonsId = await commons();

      useSession(OWNER);
      const members = await app.request(`/api/public/v1/spaces/${commonsId}/members`, { headers: jsonHeaders() });
      expect(members.status).toBe(200);
      const listed = ((await members.json()) as { members: Array<{ userId: string; role: string }> }).members;
      // Only the creator — implicit membership materializes nothing.
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ userId: OWNER.id, role: "creator" });

      const remove = await app.request(`/api/public/v1/spaces/${commonsId}/members/${A.id}`, {
        method: "DELETE",
        headers: jsonHeaders(),
      });
      expect(remove.status).toBe(404);
      expect(await errorCode(remove)).toBe("member_not_found");

      const patch = await app.request(`/api/public/v1/spaces/${commonsId}/members/${A.id}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ role: "editor" }),
      });
      expect(patch.status).toBe(404);
      expect(await errorCode(patch)).toBe("member_not_found");
    });
  });
});
