import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { activityLog, bundleVersions, files, memories } from "@defs";
import { eq } from "drizzle-orm";

import app from "../../src/index";
import {
  jsonHeaders,
  resetRuntime,
  runtime,
  seedContact,
  seedDriveFile,
  seedPublishedBundle,
  useBearer,
  useSession,
} from "./edge-runtime";

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await response.json() as { error?: { code?: string } };
  return body.error?.code;
}

async function generatePeerKeyPair() {
  const subtle = crypto.subtle as SubtleCrypto;
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKeyJwk = await subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicKeyJwk };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function signBody(privateKey: CryptoKey, body: string): Promise<string> {
  const subtle = crypto.subtle as SubtleCrypto;
  const signature = await subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(body));
  return base64Url(new Uint8Array(signature));
}

async function getBundleRow(prefix: string) {
  const [row] = await runtime.db.select().from(bundleVersions).where(eq(bundleVersions.prefix, prefix)).limit(1);
  return row;
}

async function expectBundleCurrent(prefix: string): Promise<void> {
  const response = await app.request(`/api/public/v1/bundles/current?prefix=${encodeURIComponent(prefix)}`);
  expect(response.status).toBe(200);
  const body = await response.json() as { currentVersion: { versionId: string } | null };
  expect(body.currentVersion?.versionId).toBe("dv_current");
}

function inboxPayload(from = "https://peer.example") {
  return {
    from,
    filename: "hello.txt",
    contentType: "text/plain",
    contentBase64: btoa("hello"),
    message: "for review",
    sentAt: new Date().toISOString(),
  };
}

describe("route-level integration security behaviors", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("rejects bearer tokens with narrow capability or path scopes", async () => {
    let response = await app.request("/api/public/v1/files/upload", {
      method: "POST",
      headers: jsonHeaders(useBearer(["read:drive", "path:/"])),
      body: JSON.stringify({ filename: "blocked.txt", path: "/", contentType: "text/plain", size: 1 }),
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("invalid_scope");

    response = await app.request("/api/public/v1/shares/share-id", {
      method: "DELETE",
      headers: jsonHeaders(useBearer(["read:drive", "write:drive", "path:/"])),
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("invalid_scope");

    response = await app.request("/api/public/v1/files?path=/bar", {
      headers: useBearer(["read:drive", "path:/foo/*"]),
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("invalid_scope");
  });

  it("lets browser session auth bypass bearer scope checks", async () => {
    useSession();

    const response = await app.request("/api/public/v1/files/upload", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ filename: "session.txt", path: "/bar", contentType: "text/plain", size: 7 }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { fileId?: string; uploadUrl?: string };
    expect(body.fileId).toBeTruthy();
    expect(body.uploadUrl).toMatch(/^memory:\/\/put\/drive\//u);
  });

  it("rejects bearer callers from session-only token and contact management endpoints", async () => {
    const headers = jsonHeaders(useBearer(["read:drive", "write:drive", "share:create", "path:/"]));

    const tokenResponse = await app.request("/api/public/v1/tokens", {
      method: "POST",
      headers,
      body: JSON.stringify({ scopes: ["read:drive"], expiresInDays: 1 }),
    });
    expect(tokenResponse.status).toBe(403);
    expect(await errorCode(tokenResponse)).toBe("session_required");

    const contactsResponse = await app.request("/api/public/v1/contacts", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "https://peer.example", name: "peer" }),
    });
    expect(contactsResponse.status).toBe(403);
    expect(await errorCode(contactsResponse)).toBe("session_required");
  });

  it("keeps trashed files tombstoned until restore conflict is cleared", async () => {
    useSession();
    const originalId = await seedDriveFile({ id: "original-report", path: "/docs/report.txt", body: "old" });

    const deleteResponse = await app.request(`/api/public/v1/files/${originalId}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);

    const createResponse = await app.request("/api/public/v1/files/upload", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ filename: "report.txt", path: "/docs", contentType: "text/plain", size: 3 }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as { fileId: string };

    const blockedRestore = await app.request(`/api/public/v1/files/${originalId}/restore`, { method: "POST" });
    expect(blockedRestore.status).toBe(409);
    expect(await errorCode(blockedRestore)).toBe("path_conflict");

    const moveResponse = await app.request(`/api/public/v1/files/${created.fileId}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "report-new.txt" }),
    });
    expect(moveResponse.status).toBe(200);

    const restoreResponse = await app.request(`/api/public/v1/files/${originalId}/restore`, { method: "POST" });
    expect(restoreResponse.status).toBe(200);
    const restored = await restoreResponse.json() as { file: { path: string } };
    expect(restored.file.path).toBe("/docs/report.txt");
  });

  it("requires signed inbox delivery from a pinned Ed25519 contact", async () => {
    const unsigned = await app.request("/api/public/inbox", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(inboxPayload()),
    });
    expect(unsigned.status).toBe(401);
    expect(await errorCode(unsigned)).toBe("signature_required");

    const peer = await generatePeerKeyPair();
    const unknownBody = JSON.stringify(inboxPayload());
    const unknown = await app.request("/api/public/inbox", {
      method: "POST",
      headers: jsonHeaders({ "x-agent-signature": await signBody(peer.privateKey, unknownBody) }),
      body: unknownBody,
    });
    expect(unknown.status).toBe(403);
    expect(await errorCode(unknown)).toBe("unknown_sender");

    await seedContact({
      name: "peer",
      url: "https://peer.example",
      publicKeyJwk: peer.publicKeyJwk,
      autoRelease: false,
    });
    const validBody = JSON.stringify(inboxPayload());
    const valid = await app.request("/api/public/inbox", {
      method: "POST",
      headers: jsonHeaders({ "x-agent-signature": await signBody(peer.privateKey, validBody) }),
      body: validBody,
    });
    expect(valid.status).toBe(201);
    const delivered = await valid.json() as { path: string; quarantined: boolean };
    expect(delivered.quarantined).toBe(true);
    expect(delivered.path).toBe("/inbox/pending/peer/hello.txt");

    const [row] = await runtime.db.select().from(files).where(eq(files.path, delivered.path)).limit(1);
    expect(row?.size).toBe(5);
  });

  it("only exposes manifest-listed files for published public bundles", async () => {
    const { publicId } = await seedPublishedBundle();

    const listed = await app.request(`/api/public/b/${publicId}/file?path=ok.txt`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as { downloadUrl: string; path: string };
    expect(listedBody.path).toBe("ok.txt");
    expect(listedBody.downloadUrl).toMatch(/^memory:\/\/get\/drive\//u);

    const unlisted = await app.request(`/api/public/b/${publicId}/file?path=secret.txt`);
    expect(unlisted.status).toBe(404);
    expect(await errorCode(unlisted)).toBe("file_not_found");

    const unpublished = await app.request("/api/public/b/pb_missing/current");
    expect(unpublished.status).toBe(404);
    expect(await errorCode(unpublished)).toBe("bundle_not_found");
  });

  it("keeps published bundle rows coherent through folder rename, trash, restore, and purge", async () => {
    useSession();
    const { publicId, prefix } = await seedPublishedBundle();
    const [folder] = await runtime.db.select().from(files).where(eq(files.path, prefix)).limit(1);
    expect(folder?.isFolder).toBe(1);

    const renamedPrefix = "/bundle-renamed";
    const renameResponse = await app.request(`/api/public/v1/files/${folder.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "bundle-renamed" }),
    });
    expect(renameResponse.status).toBe(200);
    expect(await getBundleRow(prefix)).toBeUndefined();
    expect((await getBundleRow(renamedPrefix))?.publicId).toBe(publicId);
    await expectBundleCurrent(renamedPrefix);

    const publicAfterRename = await app.request(`/api/public/b/${publicId}/current`);
    expect(publicAfterRename.status).toBe(200);

    const movedPrefix = "/archive/bundle-renamed";
    const batchMoveResponse = await app.request("/api/public/v1/files/batch", {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ ids: [folder.id], parentPath: "/archive" }),
    });
    expect(batchMoveResponse.status).toBe(200);
    expect(await getBundleRow(renamedPrefix)).toBeUndefined();
    expect((await getBundleRow(movedPrefix))?.publicId).toBe(publicId);
    await expectBundleCurrent(movedPrefix);

    const publicAfterMove = await app.request(`/api/public/b/${publicId}/current`);
    expect(publicAfterMove.status).toBe(200);

    const trashResponse = await app.request(`/api/public/v1/files/${folder.id}`, { method: "DELETE" });
    expect(trashResponse.status).toBe(200);
    expect((await getBundleRow(movedPrefix))?.publicId).toBeNull();

    const publicAfterTrash = await app.request(`/api/public/b/${publicId}/current`);
    expect(publicAfterTrash.status).toBe(404);
    expect(await errorCode(publicAfterTrash)).toBe("bundle_not_found");

    const unpublishedEvents = await runtime.db.select().from(activityLog).where(eq(activityLog.eventType, "bundle.unpublished"));
    expect(unpublishedEvents).toHaveLength(1);
    const metadata = JSON.parse(unpublishedEvents[0].metadata ?? "{}") as { publicId?: string; reason?: string };
    expect(metadata.publicId).toBe(publicId);
    expect(metadata.reason).toBe("trashed");

    const restoreResponse = await app.request(`/api/public/v1/files/${folder.id}/restore`, { method: "POST" });
    expect(restoreResponse.status).toBe(200);
    expect((await getBundleRow(movedPrefix))?.publicId).toBeNull();
    const publicAfterRestore = await app.request(`/api/public/b/${publicId}/current`);
    expect(publicAfterRestore.status).toBe(404);
    await expectBundleCurrent(movedPrefix);

    const secondTrashResponse = await app.request(`/api/public/v1/files/${folder.id}`, { method: "DELETE" });
    expect(secondTrashResponse.status).toBe(200);
    const purgeResponse = await app.request(`/api/public/v1/files/${folder.id}/purge`, { method: "DELETE" });
    expect(purgeResponse.status).toBe(200);
    expect(await getBundleRow(movedPrefix)).toBeUndefined();
  });

  it("detects and rebuilds a drifted memory FTS index", async () => {
    await runtime.db.insert(memories).values({
      id: "memory-drift-1",
      key: "integration:drift",
      content: "Known memory with rebuiltneedle token",
      tags: JSON.stringify(["drift"]),
      source: "integration-test",
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
    });

    const headers = useBearer(["read:memory", "write:memory"]);
    const driftedStatusResponse = await app.request("/api/public/v1/memory/index-status", { headers });
    expect(driftedStatusResponse.status).toBe(200);
    await expect(driftedStatusResponse.json()).resolves.toEqual({
      memories: 1,
      indexed: 0,
      consistent: false,
    });

    const missedRecallResponse = await app.request("/api/public/v1/memory/search?q=rebuiltneedle", { headers });
    expect(missedRecallResponse.status).toBe(200);
    const missedRecall = await missedRecallResponse.json() as { count: number };
    expect(missedRecall.count).toBe(0);

    const rebuildResponse = await app.request("/api/public/v1/memory/rebuild-index", {
      method: "POST",
      headers,
    });
    expect(rebuildResponse.status).toBe(200);
    await expect(rebuildResponse.json()).resolves.toEqual({ rebuilt: 1 });

    const repairedStatusResponse = await app.request("/api/public/v1/memory/index-status", { headers });
    expect(repairedStatusResponse.status).toBe(200);
    await expect(repairedStatusResponse.json()).resolves.toEqual({
      memories: 1,
      indexed: 1,
      consistent: true,
    });

    const repairedRecallResponse = await app.request("/api/public/v1/memory/search?q=rebuiltneedle", { headers });
    expect(repairedRecallResponse.status).toBe(200);
    const repairedRecall = await repairedRecallResponse.json() as { count: number; memories: Array<{ key: string | null }> };
    expect(repairedRecall.count).toBe(1);
    expect(repairedRecall.memories[0]?.key).toBe("integration:drift");
  });
});
