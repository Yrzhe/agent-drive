import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, contacts, files, memories, shares, webhooks } from "../../src/defs";
import { listActivities } from "../../src/lib/activity";
import { ensureFolderChain } from "../../src/lib/files";
import { callMcpTool } from "../../src/lib/mcp-tools";
import { getMemory, listMemories, recallMemories } from "../../src/lib/memory";
import { getContactByName, getContactByUrl } from "../../src/lib/peering";
import { getWebhookById, triggerWebhooks } from "../../src/lib/webhooks";
import { jsonHeaders, resetRuntime, runtime, seedBundleRow, seedContact, seedDriveFile, seedMemory, seedOwner, seedShareRow, useBearer, useSession } from "./edge-runtime";

async function seedWebhookRow(overrides: { id: string; url: string; eventTypes: string[]; ownerId: string | null }): Promise<void> {
  await runtime.db.insert(webhooks).values({
    id: overrides.id,
    url: overrides.url,
    eventTypes: JSON.stringify(overrides.eventTypes),
    secret: "test-secret",
    enabled: 1,
    lastTriggeredAt: null,
    lastStatus: null,
    failureCount: 0,
    createdAt: new Date().toISOString(),
    ownerId: overrides.ownerId,
  } as never);
}

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

  it("a cross-owner path 'collision' on rename now succeeds — per-owner namespaces (#30 Part ①b)", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    await seedDriveFile({ id: "fa", path: "/a.txt", body: "x", ownerId: "A" }); // A's file
    const bFileId = await seedDriveFile({ id: "fb", path: "/b.txt", body: "y", ownerId: "B" }); // B's file

    const headers = jsonHeaders(useBearer(["read:drive", "write:drive", "path:/"]));
    const { default: app } = await import("../../src/index");

    // Since Task 1 of #30 Part ①b, files.path is unique per-owner, not globally, so B
    // renaming to /a.txt no longer collides with A's row at /a.txt (separate owner
    // namespaces) — this must now succeed instead of raising a D1 unique-violation.
    const rename = await app.request(`/api/public/v1/files/${bFileId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ parentPath: "/", name: "a.txt" }),
    });
    expect(rename.status).toBe(200);

    const [aRow] = await runtime.db.select().from(files).where(eq(files.id, "fa")).limit(1);
    const [bRow] = await runtime.db.select().from(files).where(eq(files.id, bFileId)).limit(1);
    expect(aRow?.path).toBe("/a.txt");
    expect(aRow?.ownerId).toBe("A");
    expect(bRow?.path).toBe("/a.txt");
    expect(bRow?.ownerId).toBe("B");
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

  it("ensureFolderChain for owner B does not restore/adopt owner A's soft-deleted folder at the same path", async () => {
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    await runtime.db.insert(files).values({
      id: "fa-del",
      name: "shared",
      path: "/shared",
      parentPath: "/",
      isFolder: 1,
      size: 0,
      contentType: null,
      s3Uri: null,
      deletedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerId: "A",
    } as never); // A's soft-deleted folder at /shared

    await ensureFolderChain(runtime.db as never, "/shared", "B").catch(() => undefined);

    const [a] = await runtime.db.select().from(files).where(eq(files.id, "fa-del"));
    // B's owner-scoped lookup must not see A's soft-deleted row, so it must not restore it:
    expect(a?.deletedAt).not.toBeNull();
    expect(a?.ownerId).toBe("A");
  });

  it("owner B's share list + stats exclude owner A's shares; B cannot delete A's share", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    await seedDriveFile({ id: "fa", path: "/a.txt", body: "x", ownerId: "A" });
    await seedShareRow({ id: "sha", fileId: "fa", ownerId: "A" });
    const headers = jsonHeaders(useBearer(["read:drive", "write:drive", "share:create", "path:/"]));
    const { default: app } = await import("../../src/index");
    const list = await app.request("/api/public/v1/shares", { headers });
    const body = await list.json() as { shares: Array<{ id: string }> };
    expect(body.shares.find((s) => s.id === "sha")).toBeUndefined();
    const del = await app.request("/api/public/v1/shares/sha", { method: "DELETE", headers });
    expect(del.status).toBe(404);
  });

  it("owner B's /stats excludes owner A's files (totalFiles/totalFolders/totalSize)", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    await seedDriveFile({ id: "fa", path: "/a.txt", body: "x", ownerId: "A" });
    const headers = jsonHeaders(useBearer(["read:drive", "write:drive", "share:create", "path:/"]));
    const { default: app } = await import("../../src/index");
    const res = await app.request("/api/public/v1/stats", { headers });
    const body = await res.json() as { totalFiles: number; totalFolders: number; totalSize: number };
    expect(body.totalFiles).toBe(0);
    expect(body.totalFolders).toBe(0);
    expect(body.totalSize).toBe(0);
  });

  it("owner B's contact list + get-by-name exclude owner A's contacts; getContactByUrl stays global (inbox)", async () => {
    await seedContact({ id: "ca", name: "peer-a", url: "https://a.peer", publicKeyJwk: {}, ownerId: "A" });
    expect(await getContactByName(runtime.db as never, "peer-a", "B")).toBeNull();
    expect(await getContactByName(runtime.db as never, "peer-a", "A")).not.toBeNull();
    // inbox resolution stays global (peer isn't an authenticated owner):
    expect(await getContactByUrl(runtime.db as never, "https://a.peer")).not.toBeNull();
  });

  it("owner B cannot PATCH/DELETE owner A's contact by name", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    useSession({ id: "B", email: "b@x.test" });
    await seedContact({ name: "a-peer", url: "https://a.peer", publicKeyJwk: {}, ownerId: "A" });

    const { default: app } = await import("../../src/index");

    const del = await app.request("/api/public/v1/contacts/a-peer", { method: "DELETE", headers: jsonHeaders() });
    expect(del.status).toBe(404);

    const patch = await app.request("/api/public/v1/contacts/a-peer", {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ autoRelease: true }),
    });
    expect(patch.status).toBe(404);

    const [row] = await runtime.db.select().from(contacts).where(eq(contacts.name, "a-peer")).limit(1);
    expect(row?.ownerId).toBe("A");
    expect(row?.autoRelease).toBe(0);
  });

  it("owner B's activity feed excludes owner A's events", async () => {
    await runtime.db.insert(activityLog).values({ id: "acta", eventType: "file.uploaded", actor: "owner", createdAt: new Date().toISOString(), ownerId: "A" } as never);
    await runtime.db.insert(activityLog).values({ id: "actb", eventType: "file.uploaded", actor: "owner", createdAt: new Date().toISOString(), ownerId: "B" } as never);
    const rowsB = await listActivities(runtime.db as never, { limit: 100 }, "B");
    expect(rowsB.map((r) => r.id)).toEqual(["actb"]);
  });

  it("owner B's bundle reads exclude owner A's bundles; public-by-publicId stays global", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    await seedBundleRow({ prefix: "/proj-a", publicId: "pb_a", ownerId: "A" });
    // The public /current route resolves the manifest.json object off the
    // files table (owner-agnostic, by publicId) — seed it so the public
    // path can actually resolve, matching how a real committed bundle works.
    await seedDriveFile({
      path: "/proj-a/manifest.json",
      body: JSON.stringify({ version: 1, files: [] }),
      contentType: "application/json",
      ownerId: "A",
    });
    const headers = jsonHeaders(useBearer(["read:drive", "path:/"]));
    const { default: app } = await import("../../src/index");
    const cur = await app.request("/api/public/v1/bundles/current?prefix=/proj-a", { headers });
    const body = await cur.json() as { currentVersion: unknown | null };
    expect(body.currentVersion).toBeNull(); // B cannot see A's bundle
    const pub = await app.request("/api/public/b/pb_a/current");
    expect(pub.status).toBe(200); // public path still resolves by publicId
  });

  it("owner B's bundle /history excludes owner A's history entries at A's prefix", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    const manifest = {
      versionId: "dv_a1",
      previousVersionId: null,
      hash: "hash-a",
      machineId: "machine-a",
      pushedAt: new Date().toISOString(),
      fileCount: 1,
      totalSize: 2,
    };
    await seedDriveFile({
      path: "/proj-a/.history/dv_a1.json",
      body: JSON.stringify(manifest),
      contentType: "application/json",
      ownerId: "A",
    });
    const headers = jsonHeaders(useBearer(["read:drive", "path:/"]));
    const { default: app } = await import("../../src/index");
    const res = await app.request("/api/public/v1/bundles/history?prefix=/proj-a", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: Array<{ versionId: string }> };
    expect(body.history).toHaveLength(0);
  });

  it("owner B's bundle /manifest cannot fetch owner A's manifest at A's prefix/versionId", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    const manifest = {
      versionId: "dv_a1",
      previousVersionId: null,
      hash: "hash-a",
      machineId: "machine-a",
      pushedAt: new Date().toISOString(),
      fileCount: 1,
      totalSize: 2,
    };
    await seedDriveFile({
      path: "/proj-a/.history/dv_a1.json",
      body: JSON.stringify(manifest),
      contentType: "application/json",
      ownerId: "A",
    });
    const headers = jsonHeaders(useBearer(["read:drive", "path:/"]));
    const { default: app } = await import("../../src/index");
    const res = await app.request("/api/public/v1/bundles/manifest?prefix=/proj-a&versionId=dv_a1", { headers });
    expect(res.status).toBe(404);
  });

  it("owner B cannot list/delete/test owner A's webhook by id", async () => {
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");
    await seedWebhookRow({ id: "wh-a", url: "https://a-hook.test/x", eventTypes: ["file.uploaded"], ownerId: "A" });

    const headers = jsonHeaders(useBearer(["read:drive", "write:drive", "path:/"]));
    const { default: app } = await import("../../src/index");

    const list = await app.request("/api/public/v1/webhooks", { headers });
    const listBody = await list.json() as { webhooks: Array<{ id: string }> };
    expect(listBody.webhooks.find((w) => w.id === "wh-a")).toBeUndefined();

    const del = await app.request("/api/public/v1/webhooks/wh-a", { method: "DELETE", headers });
    expect(del.status).toBe(404);

    const test = await app.request("/api/public/v1/webhooks/wh-a/test", { method: "POST", headers });
    expect(test.status).toBe(404);

    // A's webhook must still exist (B's delete attempt did not remove it):
    const [row] = await runtime.db.select().from(webhooks).where(eq(webhooks.id, "wh-a"));
    expect(row?.ownerId).toBe("A");

    // getWebhookById itself is owner-scoped, independent of the route:
    expect(await getWebhookById(runtime.db as never, "wh-a", "B")).toBeNull();
    expect(await getWebhookById(runtime.db as never, "wh-a", "A")).not.toBeNull();
  });

  it("triggerWebhooks for an event owned by A matches only A's webhook, never B's", async () => {
    await seedWebhookRow({ id: "wh-a", url: "https://a-hook.test/x", eventTypes: ["file.uploaded"], ownerId: "A" });
    await seedWebhookRow({ id: "wh-b", url: "https://b-hook.test/x", eventTypes: ["file.uploaded"], ownerId: "B" });

    // deliverWebhook does a real DNS-check fetch before any POST; stub global
    // fetch so no network call ever fires, and record every URL it is asked
    // to hit so we can assert which webhook(s) triggerWebhooks selected.
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 });
    }) as typeof fetch;

    try {
      await triggerWebhooks(runtime.db as never, { eventType: "file.uploaded", data: null }, "A");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrls.some((u) => u.includes("a-hook.test"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("b-hook.test"))).toBe(false);
  });
});

describe("adversarial: a principal bound to owner B is fully isolated from owner A (#30 Part ①a comprehensive)", () => {
  const A_FILE_ID = "adv-fa";
  const A_TRASHED_ID = "adv-fa-trashed";
  const A_CONTACT_NAME = "adv-a-peer";
  const A_SHARE_ID = "adv-sha";
  const A_WEBHOOK_ID = "adv-wh-a";
  const A_BUNDLE_PREFIX = "/adv-a-bundle";
  const A_BUNDLE_PUBLIC_ID = "adv_pb_a";

  const bearerScopes = ["read:drive", "write:drive", "share:create", "read:memory", "write:memory", "path:/"] as const;

  afterAll(() => runtime.sqlite?.close());

  beforeEach(async () => {
    resetRuntime();
    seedOwner({ email: "b@x.test", id: "B" });
    runtime.vars.set("OWNER_EMAIL", "b@x.test");

    // A-owned rows across all 7 owned surfaces.
    await seedDriveFile({ id: A_FILE_ID, path: "/adv-folder/a.txt", body: "A-only", ownerId: "A" });
    await seedMemory({ id: "adv-ma", key: "adv-a-key", content: "A's private memory", ownerId: "A" });
    await seedContact({ id: "adv-ca", name: A_CONTACT_NAME, url: "https://adv-a.peer", publicKeyJwk: {}, ownerId: "A" });
    await seedShareRow({ id: A_SHARE_ID, fileId: A_FILE_ID, ownerId: "A" });
    await seedBundleRow({ prefix: A_BUNDLE_PREFIX, publicId: A_BUNDLE_PUBLIC_ID, ownerId: "A" });
    // The public /current route resolves the manifest.json object off the
    // files table (owner-agnostic, by publicId) — seed it so the public
    // path can actually resolve, matching how a real committed bundle works.
    await seedDriveFile({
      path: `${A_BUNDLE_PREFIX}/manifest.json`,
      body: JSON.stringify({ version: 1, files: [] }),
      contentType: "application/json",
      ownerId: "A",
    });
    await seedWebhookRow({ id: A_WEBHOOK_ID, url: "https://adv-a-hook.test/x", eventTypes: ["file.uploaded"], ownerId: "A" });
    await runtime.db.insert(activityLog).values({
      id: "adv-act-a",
      eventType: "file.uploaded",
      actor: "owner",
      createdAt: new Date().toISOString(),
      ownerId: "A",
    } as never);

    // A's trashed file, used to exercise restore/purge isolation (both
    // routes only operate on already soft-deleted rows).
    const trashedTimestamp = new Date().toISOString();
    const trashedPath = `/adv-trashed.txt~trash~${A_TRASHED_ID}`;
    await runtime.db.insert(files).values({
      id: A_TRASHED_ID,
      name: "adv-trashed.txt",
      path: trashedPath,
      parentPath: "/",
      isFolder: 0,
      size: 1,
      contentType: "text/plain",
      s3Uri: null,
      deletedAt: trashedTimestamp,
      createdAt: trashedTimestamp,
      updatedAt: trashedTimestamp,
      ownerId: "A",
    } as never);
  });

  it("B's reads across every owned surface show none of A's data", async () => {
    const headers = jsonHeaders(useBearer([...bearerScopes]));
    const { default: app } = await import("../../src/index");

    const listChecks = [
      ["/api/public/v1/files?path=/", "files"],
      ["/api/public/v1/memory", "memories"],
      ["/api/public/v1/shares", "shares"],
      ["/api/public/v1/activity", "activities"],
    ] as const;
    for (const [url, key] of listChecks) {
      const res = await app.request(url, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown[]>;
      expect(JSON.stringify(body[key] ?? [])).not.toContain("adv-a");
      expect(body[key] ?? []).toHaveLength(0);
    }

    // direct id access is 404, not another owner's row:
    expect((await app.request(`/api/public/v1/files/${A_FILE_ID}`, { headers })).status).toBe(404);

    // published-bundle current-version lookup never resolves A's bundle for B:
    const bundleRes = await app.request(`/api/public/v1/bundles/current?prefix=${A_BUNDLE_PREFIX}`, { headers });
    expect(bundleRes.status).toBe(200);
    const bundleBody = (await bundleRes.json()) as { currentVersion: unknown | null };
    expect(bundleBody.currentVersion).toBeNull();

    // /stats aggregates exclude A's file/folder/size/share:
    const statsRes = await app.request("/api/public/v1/stats", { headers });
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as { totalFiles: number; totalFolders: number; totalSize: number; totalShares: number };
    expect(statsBody.totalFiles).toBe(0);
    expect(statsBody.totalFolders).toBe(0);
    expect(statsBody.totalSize).toBe(0);
    expect(statsBody.totalShares).toBe(0);

    // contacts is a session-only route:
    useSession({ id: "B", email: "b@x.test" });
    const contactsRes = await app.request("/api/public/v1/contacts", { headers: jsonHeaders() });
    expect(contactsRes.status).toBe(200);
    const contactsBody = (await contactsRes.json()) as { contacts: Array<{ name: string }> };
    expect(contactsBody.contacts).toHaveLength(0);
  });

  it("B cannot mutate any of A's rows across owned surfaces; each attempt 404s and A's row is provably unchanged", async () => {
    const bearerHeaders = jsonHeaders(useBearer([...bearerScopes]));
    const { default: app } = await import("../../src/index");

    // files: trash / restore / purge, all owner-scoped lookups so all 404.
    const del = await app.request(`/api/public/v1/files/${A_FILE_ID}`, { method: "DELETE", headers: bearerHeaders });
    expect(del.status).toBe(404);
    const restore = await app.request(`/api/public/v1/files/${A_TRASHED_ID}/restore`, { method: "POST", headers: bearerHeaders });
    expect(restore.status).toBe(404);
    const purge = await app.request(`/api/public/v1/files/${A_TRASHED_ID}/purge`, { method: "DELETE", headers: bearerHeaders });
    expect(purge.status).toBe(404);

    const [liveFileRow] = await runtime.db.select().from(files).where(eq(files.id, A_FILE_ID)).limit(1);
    expect(liveFileRow?.ownerId).toBe("A");
    expect(liveFileRow?.deletedAt).toBeNull();
    const [trashedFileRow] = await runtime.db.select().from(files).where(eq(files.id, A_TRASHED_ID)).limit(1);
    expect(trashedFileRow?.ownerId).toBe("A");
    expect(trashedFileRow?.deletedAt).not.toBeNull();

    // shares:
    const shareDel = await app.request(`/api/public/v1/shares/${A_SHARE_ID}`, { method: "DELETE", headers: bearerHeaders });
    expect(shareDel.status).toBe(404);
    const [shareRow] = await runtime.db.select().from(shares).where(eq(shares.id, A_SHARE_ID)).limit(1);
    expect(shareRow?.ownerId).toBe("A");

    // webhooks:
    const webhookDel = await app.request(`/api/public/v1/webhooks/${A_WEBHOOK_ID}`, { method: "DELETE", headers: bearerHeaders });
    expect(webhookDel.status).toBe(404);
    const [webhookRow] = await runtime.db.select().from(webhooks).where(eq(webhooks.id, A_WEBHOOK_ID)).limit(1);
    expect(webhookRow?.ownerId).toBe("A");

    // contacts (session-only routes):
    useSession({ id: "B", email: "b@x.test" });
    const contactDel = await app.request(`/api/public/v1/contacts/${A_CONTACT_NAME}`, { method: "DELETE", headers: jsonHeaders() });
    expect(contactDel.status).toBe(404);
    const contactPatch = await app.request(`/api/public/v1/contacts/${A_CONTACT_NAME}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ autoRelease: true }),
    });
    expect(contactPatch.status).toBe(404);
    const [contactRow] = await runtime.db.select().from(contacts).where(eq(contacts.name, A_CONTACT_NAME)).limit(1);
    expect(contactRow?.ownerId).toBe("A");
    expect(contactRow?.autoRelease).toBe(0);
  });

  it("a published bundle stays reachable by publicId regardless of the requester's owner", async () => {
    const { default: app } = await import("../../src/index");
    const pub = await app.request(`/api/public/b/${A_BUNDLE_PUBLIC_ID}/current`);
    expect(pub.status).toBe(200);
  });
});
