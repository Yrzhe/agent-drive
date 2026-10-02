import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

// Real workerd + D1 + R2: no mocked EdgeSpark SDK or Node sqlite substitutions.
const attachmentImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmZ8AAAAASUVORK5CYII=", "base64");
const attachmentRequests = [];
const mf = new Miniflare({ workers: [{
  modules: [{ type: "ESModule", path: "index.js", contents: await readFile(new URL("../../dist/server/index.js", import.meta.url), "utf8") }], compatibilityDate: "2026-08-06",
  compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], r2Buckets: ["BUCKET"],
  outboundService: async (request) => {
    const url = new URL(request.url);
    attachmentRequests.push(url.href);
    assert.equal(url.hostname, "files.oaiusercontent.com", "no arbitrary attachment source requests");
    if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
    if (url.pathname === "/expired") return new Response("Expired", { status: 403 });
    if (url.pathname === "/image.png") return new Response(attachmentImage, { headers: { "content-type": "image/png", "content-length": String(attachmentImage.length) } });
    const size = url.pathname === "/large.zip" ? 500 * 1024 * 1024 : url.pathname === "/short.bin" ? 8 * 1024 * 1024 + 1 : 16 * 1024 * 1024 + 3;
    let remaining = size;
    const body = new ReadableStream({ pull(controller) {
      if (!remaining) { if (url.pathname === "/short.bin") controller.error(new Error("Fixture source disconnected")); else controller.close(); return; }
      const length = Math.min(64 * 1024, remaining);
      controller.enqueue(new Uint8Array(length).fill(73)); remaining -= length;
    } });
    return new Response(body, { headers: { "content-type": "application/octet-stream", ...(["/chunked.bin", "/short.bin"].includes(url.pathname) ? {} : { "content-length": String(size) }) } });
  },
  serviceBindings: { ASSETS: async (request) => new URL(request.url).pathname === "/" ? new Response("<!doctype html><html>Agent Drive</html>", { headers: { "content-type": "text/html" } }) : new URL(request.url).pathname === "/index.html" ? Response.redirect(new URL("/", request.url), 307) : new Response("Asset not found", { status: 404 }) },
  bindings: { OWNER_EMAIL: "owner@example.com", AGENT_TOKEN: "sites-test-secret-at-least-32-characters", ALLOWED_ORIGIN: "https://old-drive.example", MCP_ALLOWED_ORIGINS: "https://chatgpt.com,https://drive.example" },
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
  assert.equal((await request("/upload")).status, 200, "direct upload link must load SPA even when asset binding has no fallback");
  assert.equal((await request("/connect")).status, 200);
  assert.equal((await request("/assets/missing.js")).status, 404);
  assert.equal((await request("/api/public/missing")).status, 404);
  assert.equal((await request("/upload", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await json("/api/public/v1/account/status")).isAdmin, true);
  assert.equal((await json("/api/public/v1/account/status", undefined, visitor)).status, "pending");
  assert.equal((await request("/api/public/v1/files", {}, visitor)).status, 403);
  const visitorId = (await json("/api/public/session", undefined, visitor)).user.id;
  assert.equal((await rpc("tools/list", {}, visitor)).result.tools.length, 19);
  assert.equal((await request("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_files", arguments: {} } }) }, visitor)).status, 403);
  await json(`/api/public/v1/admin/waitlist/${visitorId}/approve`, {});
  const modern = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } };
  const discover = await rpc("server/discover", modern);
  assert.equal(discover.result.resultType, "complete");
  assert.ok(discover.result.supportedVersions.includes("2026-07-28"));
  assert.equal(discover.result.capabilities.events, undefined);
  const list = await rpc("tools/list", modern);
  assert.equal(list.result.tools.length, 19);
  assert.equal(list.result.tools.find((tool) => tool.name === "read_file").annotations.readOnlyHint, true);
  const attachmentTool = list.result.tools.find((tool) => tool.name === "upload_file");
  assert.deepEqual(attachmentTool._meta["openai/fileParams"], ["file"]);
  assert.deepEqual(attachmentTool.inputSchema.properties.file.required, ["download_url", "file_id"]);
  assert.deepEqual(Object.keys(attachmentTool.inputSchema.properties.file.properties).sort(), ["download_url", "file_id", "file_name", "mime_type"]);
  const attachment = (name) => ({ file_id: "file_test_attachment", download_url: `https://files.oaiusercontent.com/${name}?sig=not-persisted` });
  const imported = await rpc("tools/call", { name: "upload_file", arguments: { path: "/chat-images/poster.png", file: { ...attachment("image.png"), mime_type: "image/png", file_name: "generated-poster.png" } } });
  assert.ok(!imported.error, JSON.stringify(imported));
  assert.equal(imported.result.structuredContent.uploadStatus, "complete");
  const importedFile = imported.result.structuredContent.file;
  assert.equal(importedFile.size, attachmentImage.length);
  assert.equal(importedFile.uploadStatus, undefined);
  const importedPreview = await json(`/api/public/v1/files/${importedFile.id}/preview`);
  assert.deepEqual(Buffer.from(await (await request(importedPreview.downloadUrl, {}, {})).arrayBuffer()), attachmentImage);
  assert.equal((await request(`/api/public/v1/files/${importedFile.id}/preview`, {}, visitor)).status, 404);
  assert.ok((await rpc("tools/call", { name: "upload_file", arguments: { path: importedFile.path, file: attachment("image.png") } })).error, "existing path must not be overwritten");
  const importRows = await db.prepare("SELECT count(*) FROM files").first("count(*)");
  const bucket = await mf.getR2Bucket("BUCKET");
  const importObjects = (await bucket.list()).objects.length;
  for (const source of ["redirect", "expired"]) {
    console.log(`Checking attachment failure cleanup: ${source}`);
    const failed = await rpc("tools/call", { name: "upload_file", arguments: { path: `/failed-${source}.bin`, file: attachment(source) } });
    assert.ok(failed.error, source);
    assert.equal(await db.prepare("SELECT count(*) FROM files").first("count(*)"), importRows, "failed attachment creates no pending/completed file");
    assert.equal((await bucket.list()).objects.length, importObjects, "failed attachment storage is cleaned up");
  }
  const chunked = await rpc("tools/call", { name: "upload_file", arguments: { path: "/chat-images/chunked.bin", file: attachment("chunked.bin") } });
  assert.equal(chunked.result.structuredContent.file.size, 16 * 1024 * 1024 + 3);
  console.log("Checking real 500 MiB attachment ingestion into R2.");
  const largeImport = await rpc("tools/call", { name: "upload_file", arguments: { path: "/chat-images/large.zip", file: attachment("large.zip") } });
  assert.ok(!largeImport.error, JSON.stringify(largeImport));
  assert.equal(largeImport.result.structuredContent.file.size, 500 * 1024 * 1024);
  const largeImportPreview = await json(`/api/public/v1/files/${largeImport.result.structuredContent.file.id}/preview`);
  const largeImportTail = await request(largeImportPreview.downloadUrl, { headers: { range: "bytes=-4" } }, {});
  assert.deepEqual([...new Uint8Array(await largeImportTail.arrayBuffer())], [73, 73, 73, 73]);
  assert.ok(!JSON.stringify(await json("/api/public/v1/activity")).includes("not-persisted"), "signed attachment URL never enters the audit log");
  const pendingImage = await json("/api/public/v1/files/upload", { filename: "pending.png", path: "/chat-images", size: attachmentImage.length, contentType: "image/png" });
  assert.equal(new URL(pendingImage.uploadUrl).origin, "https://drive.example", "old browser origin config must not override current transfer host");
  assert.equal((await json(`/api/public/v1/files/${pendingImage.fileId}`)).file.uploadStatus, "pending");
  assert.equal((await request(`/api/public/v1/files/${pendingImage.fileId}/preview`)).status, 409);
  const emptyText = await rpc("tools/call", { name: "write_file", arguments: { path: "/chat-images/.keep", content: "" } });
  assert.equal(emptyText.result.structuredContent.file.size, 0);
  assert.equal(emptyText.result.structuredContent.file.uploadStatus, undefined, "completed zero-byte file is not pending");
  console.log("Attachment ingestion verified: byte-identical PNG, 500 MiB streamed file, chunked source, cleanup, pending status, and hostname changes.");
  // Production Sites requests omit Mcp-Method/Mcp-Name even with the modern header.
  const sitesHeaders = { "MCP-Protocol-Version": "2026-07-28" };
  const forwarded = await json("/mcp", { jsonrpc: "2.0", id: 1, method: "server/discover", params: modern }, sitesHeaders);
  assert.equal(forwarded.result.resultType, "complete");
  const catalog = await json("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, sitesHeaders);
  assert.equal(catalog.result.tools.length, 19);
  assert.ok(!JSON.stringify(catalog).includes("owner@example.com"));
  const unauthenticatedInitialize = await rpc("initialize", { protocolVersion: "2025-11-25" }, {});
  assert.equal(unauthenticatedInitialize.result.protocolVersion, "2025-11-25");
  assert.ok(unauthenticatedInitialize.result.instructions.includes("No scopes have been granted"));
  const modernHandshake = await json("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } }, sitesHeaders);
  assert.equal(modernHandshake.result.protocolVersion, "2025-11-25");
  assert.equal(modernHandshake.result.resultType, undefined);
  assert.equal((await request("/mcp", { method: "POST", headers: sitesHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_files", arguments: {}, ...modern } }) }, {})).status, 401);
  for (const name of ["list_files", "write_file"]) {
    assert.equal((await request("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) }, {})).status, 401);
  }
  const legacy = await rpc("initialize", {}, { authorization: "Bearer sites-test-secret-at-least-32-characters" }, "/api/public/mcp");
  assert.equal(legacy.result.protocolVersion, "2024-11-05");
  const mismatch = await request("/mcp", { method: "POST", headers: { "Mcp-Method": "tools/call", "MCP-Protocol-Version": "2026-07-28" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: modern }) });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.code, -32020);
  const nameMismatch = await request("/mcp", { method: "POST", headers: { ...sitesHeaders, "Mcp-Name": "write_file" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_files", arguments: {}, ...modern } }) });
  assert.equal(nameMismatch.status, 400);
  const versionMismatch = await request("/mcp", { method: "POST", headers: { "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: modern }) });
  assert.equal(versionMismatch.status, 400);
  const badCapabilities = await request("/mcp", { method: "POST", headers: sitesHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/clientCapabilities": [] } } }) }, {});
  assert.equal(badCapabilities.status, 400);
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
  const forwardedRead = await json("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/中文 100%.txt" }, ...modern } }, { ...owner, ...sitesHeaders });
  assert.ok(JSON.stringify(forwardedRead).includes(text));
  const cleanCatalog = await rpc("tools/list", {}, {});
  assert.ok(!JSON.stringify(cleanCatalog).includes(text) && !JSON.stringify(cleanCatalog).includes("/中文 100%.txt"));
  const savedFile = written.result.structuredContent.file;
  const latest = await json("/api/public/v1/shares", { fileId: savedFile.id, shareMode: "latest" });
  const fixed = await json("/api/public/v1/shares", { fileId: savedFile.id, shareMode: "fixed", password: "version-password" });
  assert.equal(fixed.share.shareMode, "fixed");
  const fixedAccess = await json(`/api/public/s/${fixed.share.id}/access`, { password: "version-password" }, {});
  const fixedHeaders = { "x-access-token": fixedAccess.accessToken };
  const history = await json(`/api/public/v1/files/${savedFile.id}/versions`);
  assert.equal(history.versions.length, 1);
  const oldVersion = history.versions[0].id;
  const next = await rpc("tools/call", { name: "write_file", arguments: { path: savedFile.path, content: "version B" }, ...modern });
  assert.ok(!next.result?.isError && !next.error, JSON.stringify(next));
  async function sharedBytes(share, headers = {}) {
    if (!headers["x-access-token"]) {
      const access = await json(`/api/public/s/${share.share.id}/access`, {}, {});
      headers = { "x-access-token": access.accessToken };
    }
    const grant = await json(`/api/public/s/${share.share.id}/download`, undefined, headers);
    const response = await request(grant.downloadUrl, {}, {});
    assert.equal(response.status, 200);
    return response.text();
  }
  assert.equal(await sharedBytes(latest), "version B");
  assert.equal(await sharedBytes(fixed, fixedHeaders), text);
  const updatedHistory = await json(`/api/public/v1/files/${savedFile.id}/versions`);
  assert.equal(updatedHistory.versions.length, 2);
  assert.equal(updatedHistory.versions.filter((v) => v.current).length, 1);
  assert.equal((await request(`/api/public/v1/files/${savedFile.id}/versions`, {}, visitor)).status, 404);
  await json(`/api/public/v1/files/${savedFile.id}/versions/${oldVersion}/restore`, {});
  assert.equal(await sharedBytes(latest), text);
  const revision = await json(`/api/public/v1/files/${savedFile.id}/versions/upload`, { size: 9, contentType: "text/plain" });
  assert.equal((await request(revision.uploadUrl, { method: "PUT", body: "version C" }, {})).status, 200);
  await json(`/api/public/v1/files/${savedFile.id}/versions/complete`, { sessionId: revision.sessionId });
  assert.equal(await sharedBytes(latest), "version C");
  assert.equal(await sharedBytes(fixed, fixedHeaders), text);
  const conflict = await json(`/api/public/v1/files/${savedFile.id}/versions/upload`, { size: 9 });
  assert.equal((await request(conflict.uploadUrl, { method: "PUT", body: "version D" }, {})).status, 200);
  await rpc("tools/call", { name: "write_file", arguments: { path: savedFile.path, content: "version E" }, ...modern });
  assert.equal((await request(`/api/public/v1/files/${savedFile.id}/versions/complete`, { method: "POST", body: JSON.stringify({ sessionId: conflict.sessionId }) })).status, 409);
  assert.equal(await sharedBytes(latest), "version E");
  const mcpFixed = await rpc("tools/call", { name: "create_share", arguments: { file_path: savedFile.path, share_mode: "fixed", version_id: oldVersion }, ...modern });
  assert.equal(mcpFixed.result.structuredContent.shareMode, "fixed");
  assert.equal((await json(`/api/public/s/${mcpFixed.result.structuredContent.shareId}`)).shareMode, "fixed");
  const racing = await Promise.all([json(`/api/public/v1/files/${savedFile.id}/versions/upload`, { size: 1 }), json(`/api/public/v1/files/${savedFile.id}/versions/upload`, { size: 1 })]);
  for (let i = 0; i < racing.length; i++) assert.equal((await request(racing[i].uploadUrl, { method: "PUT", body: i ? "Y" : "X" }, {})).status, 200);
  const races = await Promise.all(racing.map((ticket) => request(`/api/public/v1/files/${savedFile.id}/versions/complete`, { method: "POST", body: JSON.stringify({ sessionId: ticket.sessionId }) })));
  assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
  const isolated = await rpc("tools/call", { name: "read_file", arguments: { path: "/中文 100%.txt" }, ...modern }, visitor);
  assert.ok(isolated.error || isolated.result?.isError, "visitor must not read owner file");
  // Concurrent requests must never reuse another request's principal.
  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, n) => json("/api/public/session", undefined, n % 2 ? owner : visitor)));
  for (let n = 0; n < concurrent.length; n++) assert.equal(concurrent[n].user.email, n % 2 ? "owner@example.com" : "visitor@example.com");
  const privateVisitorFile = await rpc("tools/call", { name: "write_file", arguments: { path: "/visitor-private.txt", content: "not in owner root share" }, ...modern }, visitor);
  const rootShare = await json("/api/public/v1/shares", { folderPath: "/" });
  const rootAccess = await json(`/api/public/s/${rootShare.share.id}/access`, {}, {});
  const rootHeaders = { "x-access-token": rootAccess.accessToken };
  const rootFiles = await json(`/api/public/s/${rootShare.share.id}/files`, undefined, rootHeaders);
  assert.ok(!rootFiles.files.some((f) => f.id === privateVisitorFile.result.structuredContent.file.id), "owner root share excludes another user's files");
  assert.equal((await request(`/api/public/s/${rootShare.share.id}/download?fileId=${privateVisitorFile.result.structuredContent.file.id}`, { headers: rootHeaders }, {})).status, 404);
  assert.equal((await request("/api/public/v1/shares", { method: "POST", body: JSON.stringify({ fileId: privateVisitorFile.result.structuredContent.file.id }) })).status, 404);
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
  // Transfer a real 500 MiB binary using bounded chunks; never allocate the whole
  // file in the client or load it through the inline read_file text path.
  const ownerId = (await json("/api/public/session")).user.id;
  const beforeLink = await db.prepare("SELECT count(*) AS count FROM files").first("count");
  const browserLink = (await rpc("tools/call", { name: "prepare_file_upload", arguments: { path: "/local-program.zip" }, ...modern })).result.structuredContent;
  const uploadPage = new URL(browserLink.uploadPageUrl);
  assert.equal(uploadPage.pathname, "/upload");
  assert.equal(uploadPage.searchParams.get("account"), ownerId);
  assert.equal(uploadPage.searchParams.get("path"), "/local-program.zip");
  assert.equal(await db.prepare("SELECT count(*) AS count FROM files").first("count"), beforeLink, "link-only preparation creates no pending file");
  const programSize = 500 * 1024 * 1024;
  const program = (await rpc("tools/call", { name: "prepare_file_upload", arguments: { path: "/program-500MiB.zip", size: programSize }, ...modern })).result.structuredContent;
  assert.equal(program.uploadMode, "transfer");
  assert.equal(program.multipart.partSize, 8 * 1024 * 1024);
  await json(program.uploadUrl, { action: "start" }, {});
  for (let offset = 0, part = 1; offset < programSize; offset += program.multipart.partSize, part++) {
    const size = Math.min(program.multipart.partSize, programSize - offset);
    const chunk = new Uint8Array(size).fill(part % 256);
    const response = await request(program.uploadUrl + `&part=${part}`, { method: "PUT", body: chunk }, {});
    assert.equal(response.status, 200, await response.text());
  }
  await json(program.uploadUrl, { action: "complete" }, {});
  const stolenCompletion = await rpc("tools/call", { name: "complete_file_upload", arguments: { file_id: program.fileId }, ...modern }, visitor);
  assert.ok(stolenCompletion.error, "another account cannot complete an upload ticket");
  const programCompleted = await rpc("tools/call", { name: "complete_file_upload", arguments: { file_id: program.fileId }, ...modern });
  assert.equal(programCompleted.result.structuredContent.file.size, programSize);
  const programDownload = await json(`/api/public/v1/files/${program.fileId}/preview`);
  assert.equal((await request(programDownload.downloadUrl, { method: "HEAD" }, {})).headers.get("content-length"), String(programSize));
  const programTail = await request(programDownload.downloadUrl, { headers: { Range: `bytes=${programSize - 4}-${programSize - 1}` } }, {});
  assert.equal(programTail.status, 206);
  assert.deepEqual([...new Uint8Array(await programTail.arrayBuffer())], [63, 63, 63, 63]);
  assert.ok((await rpc("tools/call", { name: "complete_file_upload", arguments: { file_id: program.fileId }, ...modern })).error, "completion cannot replay");
  console.log("Verified real 500 MiB program upload, byte count and download range through MCP + R2 multipart.");
  const huge = await json("/api/public/v1/files/upload", { filename: "maximum-size.bin", contentType: "application/octet-stream", size: 671088640000, path: "/" });
  assert.equal(huge.multipart.partSize, 64 * 1024 * 1024);
  assert.equal(Math.ceil(671088640000 / huge.multipart.partSize), 10000);
  assert.ok(Date.parse(huge.expiresAt) > Date.now() + 24 * 3600_000, "large uploads receive a size-based time budget");
  const tooLarge = await request("/api/public/v1/files/upload", { method: "POST", body: JSON.stringify({ filename: "oversize.bin", size: 671088640001 }) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, "file_too_large");
  const wrongSize = await json("/api/public/v1/files/upload", { filename: "wrong-size.bin", size: 3 });
  assert.equal((await request(wrongSize.uploadUrl, { method: "PUT", body: new Uint8Array(2) }, {})).status, 400);
  const scoped = await json("/api/public/v1/tokens", { label: "readonly", scopes: ["read:drive"], pathPrefix: "/" });
  assert.ok(scoped.token, JSON.stringify(scoped));
  const limited = await rpc("tools/list", {}, { authorization: `Bearer ${scoped.token}` }, "/api/public/mcp");
  assert.ok(!limited.result.tools.some((tool) => tool.name === "write_file"));
  assert.ok(!limited.result.tools.some((tool) => ["upload_file", "prepare_file_upload", "complete_file_upload"].includes(tool.name)));
  const deniedSourceRequests = attachmentRequests.length;
  const readonlyAttachment = await rpc("tools/call", { name: "upload_file", arguments: { path: "/forbidden.png", file: attachment("image.png") } }, { authorization: `Bearer ${scoped.token}` }, "/api/public/mcp");
  assert.equal(readonlyAttachment.error.code, -32001);
  assert.equal(attachmentRequests.length, deniedSourceRequests, "unauthorized calls never fetch an attachment");
  const readonlyUpload = await rpc("tools/call", { name: "prepare_file_upload", arguments: { path: "/forbidden.zip", size: 500000000 } }, { authorization: `Bearer ${scoped.token}` }, "/api/public/mcp");
  assert.equal(readonlyUpload.error.code, -32001);
  const scopedWriter = await json("/api/public/v1/tokens", { label: "upload-path", scopes: ["write:drive"], pathPrefix: "/allowed" });
  const wrongPath = await rpc("tools/call", { name: "prepare_file_upload", arguments: { path: "/outside.zip", size: 500000000 } }, { authorization: `Bearer ${scopedWriter.token}` }, "/api/public/mcp");
  assert.equal(wrongPath.error.code, -32001);
  const wrongAttachmentPath = await rpc("tools/call", { name: "upload_file", arguments: { path: "/outside.png", file: attachment("image.png") } }, { authorization: `Bearer ${scopedWriter.token}` }, "/api/public/mcp");
  assert.equal(wrongAttachmentPath.error.code, -32001);
  assert.equal(attachmentRequests.length, deniedSourceRequests, "out-of-scope attachment never leaves the server");
  await db.prepare("UPDATE user_access SET status='suspended' WHERE user_id=?").bind(visitorId).run();
  assert.equal((await request("/api/public/v1/files", {}, visitor)).status, 403);
  assert.equal((await rpc("tools/list", {}, visitor)).result.tools.length, 19);
  assert.equal((await request("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_files", arguments: {} } }) }, visitor)).status, 403);
  console.log("Sites workerd checks passed: D1 migrations/FTS, native identity, approval/suspension, concurrent isolation, MCP 2.0/legacy, immutable versions/restore/latest/fixed/password shares/conflicts, Unicode/R2 streaming/ranges, multipart, quota boundary and replay/tamper protection.");
} finally { await mf.dispose(); }
