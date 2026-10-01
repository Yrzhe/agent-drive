import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

// Real workerd + D1 + R2: no mocked EdgeSpark SDK or Node sqlite substitutions.
const mf = new Miniflare({ workers: [{
  modules: [{ type: "ESModule", path: "index.js", contents: await readFile(new URL("../../dist/server/index.js", import.meta.url), "utf8") }], compatibilityDate: "2026-08-06",
  compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], r2Buckets: ["BUCKET"],
  bindings: { OWNER_EMAIL: "owner@example.com", AGENT_TOKEN: "sites-test-secret-at-least-32-characters", ALLOWED_ORIGIN: "https://drive.example", MCP_ALLOWED_ORIGINS: "https://chatgpt.com" },
}] });
const owner = { "oai-authenticated-user-id": "owner-subject", "oai-authenticated-user-email": "owner@example.com" };
const visitor = { "oai-authenticated-user-id": "visitor-subject", "oai-authenticated-user-email": "visitor@example.com" };
async function request(path, options = {}, headers = owner) {
  return mf.dispatchFetch(new URL(path, "https://drive.example"), {
    ...options, headers: { "content-type": "application/json", ...headers, ...options.headers },
  });
}
async function json(path, body, headers = owner) {
  const response = await request(path, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, headers);
  const payload = await response.json();
  assert.ok(response.status >= 200 && response.status < 300, `HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}
async function rpc(method, params = {}, headers = owner, path = "/mcp") {
  const modern = params._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28";
  return json(path, { jsonrpc: "2.0", id: 1, method, params }, { ...headers, ...(modern ? { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(params.name ? { "Mcp-Name": params.name } : {}) } : {}) });
}
try {
  const db = await mf.getD1Database("DB");
  const directory = "../platforms/chatgpt-sites/drizzle";
  for (const file of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
    const sql = await readFile(`${directory}/${file}`, "utf8");
    for (const statement of sql.split("--> statement-breakpoint").filter((sql) => sql.trim())) await db.prepare(statement).run();
  }
  assert.equal((await json("/api/public/v1/account/status")).isAdmin, true);
  assert.equal((await json("/api/public/v1/account/status", undefined, visitor)).status, "pending");
  assert.equal((await request("/api/public/v1/files", {}, visitor)).status, 403);
  const visitorId = (await json("/api/public/session", undefined, visitor)).user.id;
  await json(`/api/public/v1/admin/waitlist/${visitorId}/approve`, {});
  const modern = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } };
  const discover = await rpc("server/discover", modern);
  assert.equal(discover.result.resultType, "complete");
  assert.ok(discover.result.supportedVersions.includes("2026-07-28"));
  assert.equal(discover.result.capabilities.events, undefined);
  const list = await rpc("tools/list", modern);
  assert.equal(list.result.tools.length, 16);
  assert.equal(list.result.tools.find((tool) => tool.name === "read_file").annotations.readOnlyHint, true);
  const legacy = await rpc("initialize", {}, { authorization: "Bearer sites-test-secret-at-least-32-characters" }, "/api/public/mcp");
  assert.equal(legacy.result.protocolVersion, "2024-11-05");
  const mismatch = await request("/mcp", { method: "POST", headers: { "Mcp-Method": "tools/call", "MCP-Protocol-Version": "2026-07-28" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: modern }) });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.code, -32020);
  const badVersion = await request("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } }) });
  assert.equal(badVersion.status, 400);
  assert.equal((await badVersion.json()).error.code, -32022);
  assert.equal((await request("/mcp", { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" })).status, 403);
  assert.equal((await request("/mcp", { method: "POST", body: "{}" }, {})).status, 401);
  const text = "Hello 原生 Cloudflare 🌤️";
  const written = await rpc("tools/call", { name: "write_file", arguments: { path: "/中文 100%.txt", content: text }, ...modern });
  assert.ok(!written.error, JSON.stringify(written));
  const read = await rpc("tools/call", { name: "read_file", arguments: { path: "/中文 100%.txt" }, ...modern });
  assert.ok(JSON.stringify(read).includes(text));
  const isolated = await rpc("tools/call", { name: "read_file", arguments: { path: "/中文 100%.txt" }, ...modern }, visitor);
  assert.ok(isolated.error || isolated.result?.isError, "visitor must not read owner file");
  // Concurrent requests must never reuse another request's principal.
  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, n) => json("/api/public/session", undefined, n % 2 ? owner : visitor)));
  for (let n = 0; n < concurrent.length; n++) assert.equal(concurrent[n].user.email, n % 2 ? "owner@example.com" : "visitor@example.com");
  const remembered = await rpc("tools/call", { name: "remember", arguments: { key: "native", content: "Cloudflare durable memory", tags: ["cloudflare"] }, ...modern });
  assert.ok(!remembered.error, JSON.stringify(remembered));
  const recalled = await rpc("tools/call", { name: "recall", arguments: { query: "Cloudflare" }, ...modern });
  assert.ok(JSON.stringify(recalled).includes("durable memory"));
  async function upload(filename, bytes, multipart = false) {
    const ticket = await json("/api/public/v1/files/upload", { filename, contentType: "application/octet-stream", size: bytes.length, path: "/" });
    if (multipart) {
      await json(ticket.uploadUrl, { action: "start" }, {});
      for (let offset = 0, part = 1; offset < bytes.length; offset += ticket.multipart.partSize, part++) {
        const response = await request(ticket.uploadUrl + `&part=${part}`, { method: "PUT", body: bytes.subarray(offset, offset + ticket.multipart.partSize) }, {});
        assert.equal(response.status, 200, await response.text());
      }
      await json(ticket.uploadUrl, { action: "complete" }, {});
    } else {
      const response = await request(ticket.uploadUrl, { method: "PUT", body: bytes }, {});
      assert.equal(response.status, 200, await response.text());
      assert.equal((await request(ticket.uploadUrl, { method: "PUT", body: bytes }, {})).status, 409, "no replay overwrite");
    }
    const completed = await json("/api/public/v1/files/upload/complete", { fileId: ticket.fileId, filename, path: "/" });
    const download = await json(`/api/public/v1/files/${completed.file.id}/preview`);
    const response = await request(download.downloadUrl, {}, {});
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    const range = await request(download.downloadUrl, { headers: { Range: "bytes=1-3" } }, {});
    assert.equal(range.status, 206);
    assert.deepEqual(new Uint8Array(await range.arrayBuffer()), bytes.subarray(1, 4));
    assert.equal((await request(download.downloadUrl.slice(0, -1) + "!", {}, {})).status, 401);
    return { ticket, completed };
  }
  await upload("中文 100% #?.bin", new TextEncoder().encode("binary unicode name payload"));
  await upload("multipart.bin", new Uint8Array(16 * 1024 * 1024 + 127).fill(73), true);
  const scoped = await json("/api/public/v1/tokens", { label: "readonly", scopes: ["read:drive"], pathPrefix: "/" });
  assert.ok(scoped.token, JSON.stringify(scoped));
  const limited = await rpc("tools/list", {}, { authorization: `Bearer ${scoped.token}` }, "/api/public/mcp");
  assert.ok(!limited.result.tools.some((tool) => tool.name === "write_file"));
  await db.prepare("UPDATE user_access SET status='suspended' WHERE user_id=?").bind(visitorId).run();
  assert.equal((await request("/api/public/v1/files", {}, visitor)).status, 403);
  assert.equal((await request("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, visitor)).status, 403);
  console.log("Sites workerd checks passed: D1 migrations/FTS, native identity, approval/suspension, concurrent isolation, scoped MCP 2.0/legacy, Unicode/R2 streaming/ranges, multipart and transfer replay/tamper protection.");
} finally { await mf.dispose(); }
