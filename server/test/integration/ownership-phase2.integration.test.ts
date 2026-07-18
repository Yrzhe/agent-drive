import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { activityLog, files, memories, shares, webhooks } from "../../src/defs";
import {
  jsonHeaders,
  resetRuntime,
  runtime,
  seedContact,
  seedDriveFile,
  seedOwner,
  useBearer,
  useSession,
} from "./edge-runtime";

const OWNER_ID = "owner-123";
const OWNER_EMAIL = "owner@example.test";
const SCOPES = ["read:drive", "write:drive", "share:create", "path:/"];

// --- Ed25519 peering helpers (inbox delivery is signed by the sending contact) ---
async function generatePeerKeyPair() {
  const subtle = crypto.subtle as SubtleCrypto;
  const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
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

async function rpc(headers: HeadersInit, method: string, params?: unknown): Promise<Response> {
  return app.request("/api/public/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function ownerOfFile(path: string): Promise<string | null> {
  const [row] = await runtime.db.select().from(files).where(eq(files.path, path)).limit(1);
  return (row?.ownerId as string | null) ?? null;
}

let app: typeof import("../../src/index")["default"];

describe("multi-tenancy Phase 2 — owner-on-insert (#30)", () => {
  beforeEach(async () => {
    resetRuntime();
    seedOwner({ email: OWNER_EMAIL, id: OWNER_ID });
    runtime.vars.set("OWNER_EMAIL", OWNER_EMAIL);
    ({ default: app } = await import("../../src/index"));
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  describe("REST inserts stamp the session owner", () => {
    it("creating a folder stamps owner_id on the new folder row", async () => {
      useSession({ id: OWNER_ID, email: OWNER_EMAIL });
      const res = await app.request("/api/public/v1/folders", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "docs", path: "/" }),
      });
      expect(res.status).toBe(200);
      expect(await ownerOfFile("/docs")).toBe(OWNER_ID);
    });

    it("auto-created parent folders (ensureFolderChain) are stamped too", async () => {
      useSession({ id: OWNER_ID, email: OWNER_EMAIL });
      const res = await app.request("/api/public/v1/folders", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "child", path: "/parent" }),
      });
      expect(res.status).toBe(200);
      expect(await ownerOfFile("/parent")).toBe(OWNER_ID); // created by ensureFolderChain
      expect(await ownerOfFile("/parent/child")).toBe(OWNER_ID);
    });

    it("registering a webhook stamps owner_id", async () => {
      useSession({ id: OWNER_ID, email: OWNER_EMAIL });
      // The route resolves the URL host over DoH to block private/reserved targets; stub it
      // to a public A record so the check is deterministic and network-free.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }), {
          headers: { "content-type": "application/dns-json" },
        })) as typeof fetch;
      try {
        const res = await app.request("/api/public/v1/webhooks", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ url: "https://hooks.myapp.io/x", eventTypes: ["file.uploaded"] }),
        });
        expect(res.status).toBe(201);
      } finally {
        globalThis.fetch = realFetch;
      }
      const [row] = await runtime.db.select().from(webhooks).limit(1);
      expect(row?.ownerId).toBe(OWNER_ID);
    });

    it("remembering a memory stamps owner_id and logs an owned activity row", async () => {
      useSession({ id: OWNER_ID, email: OWNER_EMAIL });
      const res = await app.request("/api/public/v1/memory", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ content: "hello", key: "greeting" }),
      });
      expect(res.status).toBe(201);
      const [mem] = await runtime.db.select().from(memories).where(eq(memories.key, "greeting")).limit(1);
      expect(mem?.ownerId).toBe(OWNER_ID);
      const [act] = await runtime.db
        .select()
        .from(activityLog)
        .where(eq(activityLog.eventType, "memory.created"))
        .limit(1);
      expect(act?.ownerId).toBe(OWNER_ID);
    });
  });

  describe("bearer (agent) inserts stamp the resolved owner", () => {
    it("upload-init stamps owner_id on the pending file row", async () => {
      const headers = jsonHeaders(useBearer(SCOPES));
      const res = await app.request("/api/public/v1/files/upload", {
        method: "POST",
        headers,
        body: JSON.stringify({ filename: "a.txt", path: "/", size: 3, contentType: "text/plain" }),
      });
      expect(res.status).toBe(200);
      expect(await ownerOfFile("/a.txt")).toBe(OWNER_ID);
    });

    it("MCP write_file stamps owner_id", async () => {
      const headers = jsonHeaders(useBearer(SCOPES));
      const res = await rpc(headers, "tools/call", {
        name: "write_file",
        arguments: { path: "/note.txt", content: "hi" },
      });
      expect(res.status).toBe(200);
      expect(await ownerOfFile("/note.txt")).toBe(OWNER_ID);
    });

    it("MCP create_share stamps owner_id on the share", async () => {
      await seedDriveFile({ id: "sf", path: "/report.txt", body: "r" });
      const headers = jsonHeaders(useBearer(SCOPES));
      const res = await rpc(headers, "tools/call", {
        name: "create_share",
        arguments: { file_path: "/report.txt" },
      });
      expect(res.status).toBe(200);
      const [row] = await runtime.db.select().from(shares).limit(1);
      expect(row?.ownerId).toBe(OWNER_ID);
    });
  });

  describe("owner is preserved on update, never reassigned", () => {
    it("remember-by-key updates content without overwriting an existing owner", async () => {
      await runtime.db.insert(memories).values({
        id: "m-existing",
        key: "shared-key",
        content: "old",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ownerId: "someone-else",
      } as never);

      useSession({ id: OWNER_ID, email: OWNER_EMAIL });
      const res = await app.request("/api/public/v1/memory", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ content: "new", key: "shared-key" }),
      });
      expect(res.status).toBe(200); // updated, not created

      const [mem] = await runtime.db.select().from(memories).where(eq(memories.key, "shared-key")).limit(1);
      expect(mem?.content).toBe("new");
      expect(mem?.ownerId).toBe("someone-else"); // owner untouched
    });
  });

  describe("inbox deliveries belong to the receiving contact's owner", () => {
    it("stamps the received file with contact.ownerId (not the deployment owner)", async () => {
      const peer = await generatePeerKeyPair();
      await seedContact({
        name: "peer",
        url: "https://peer.example",
        publicKeyJwk: peer.publicKeyJwk,
        autoRelease: true,
        ownerId: "contact-owner",
      });
      const payload = JSON.stringify({
        from: "https://peer.example",
        filename: "gift.txt",
        contentType: "text/plain",
        contentBase64: btoa("hello"),
        message: "hi",
        sentAt: new Date().toISOString(),
      });
      const res = await app.request("/api/public/inbox", {
        method: "POST",
        headers: jsonHeaders({ "x-agent-signature": await signBody(peer.privateKey, payload) }),
        body: payload,
      });
      expect(res.status).toBe(201);
      const { path } = (await res.json()) as { path: string };
      expect(await ownerOfFile(path)).toBe("contact-owner");
    });
  });

  describe("legacy: unresolved owner writes NULL, never crashes", () => {
    it("agent_token with OWNER_EMAIL unset leaves owner_id NULL on new rows", async () => {
      resetRuntime(); // clears OWNER_EMAIL and the seeded owner
      ({ default: app } = await import("../../src/index"));
      const headers = jsonHeaders(useBearer(SCOPES));
      const res = await rpc(headers, "tools/call", {
        name: "write_file",
        arguments: { path: "/legacy.txt", content: "x" },
      });
      expect(res.status).toBe(200);
      const [{ n }] = await runtime.db
        .select({ n: sql<number>`count(*)` })
        .from(files)
        .where(and(eq(files.path, "/legacy.txt"), isNull(sql`owner_id`)));
      expect(Number(n)).toBe(1);
    });
  });
});
