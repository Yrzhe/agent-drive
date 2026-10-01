import { getPlatform } from "@platform";
import { Hono } from "hono";

import { checkAccessGate } from "../lib/access";
import { ApiError } from "../lib/errors";
import { authenticateMcpBearer, type McpAuthContext } from "../lib/mcp-auth";
import { callMcpTool, listMcpTools } from "../lib/mcp-tools";
import { DEFAULT_AGENT_TOKEN_SCOPES } from "../lib/mcp-scopes";

export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const SERVER_INFO = { name: "agent-drive", version: "0.2.0" };

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }, { status });
}

// Streamable HTTP requires the MCP endpoint to support both POST and GET.
// We do not offer an SSE stream, which the spec says MUST be signalled with
// 405 — never 404: in MCP, a 404 means "this session was terminated, start a
// new one with a fresh InitializeRequest", so 404 here would push Streamable
// HTTP clients into a needless re-initialize loop.
function methodNotAllowed(detail: string): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed", detail }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "POST" },
  });
}

function unauthorized(origin: string, native = false): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      ...(native ? {} : { "WWW-Authenticate": `Bearer resource_metadata="${origin}/api/public/.well-known/oauth-protected-resource"` }),
    },
  });
}

function initializeResult(origin: string, auth: McpAuthContext) {
  const scopeList = auth.scopes.length ? auth.scopes.join(" ") : "(none)";
  const instructions = [
    `Agent Drive MCP at ${origin} — an agent-native private cloud drive (files, shares, cross-session memory, drive-to-drive send).`,
    `Auth mode: ${auth.kind}. Your granted scopes: ${scopeList}. Call tools/list for schemas.`,
    ``,
    `Tools -> required scope:`,
    `- list_files, read_file, search_files -> read:drive (read_file returns file TEXT directly — no share needed)`,
    `- write_file -> write:drive. UTF-8 TEXT only, max 5MB. For binary or large files (PDF, images, video) do NOT use write_file — use the REST presigned flow: POST ${origin}/api/public/v1/files/upload -> PUT the bytes to the returned uploadUrl -> POST ${origin}/api/public/v1/files/upload/complete.`,
    `- When the upload ticket includes multipart.partSize, larger files require POST uploadUrl {action:"start"}, sequential PUT uploadUrl&part=N (1-based bounded chunks), POST uploadUrl {action:"complete"}, then REST /files/upload/complete.`,
    ...(auth.kind === "sites" ? [`Sites /mcp uses platform OAuth. Sites audience restrictions apply to all URLs, including shares, public bundles and inbox; app-public does not imply platform-public.`] : []),
    `- create_share, send_file -> share:create`,
    `- remember, recall, list_memories, forget -> read:memory / write:memory`,
    `- list_spaces, read_space -> read:drive; add_to_space, remove_from_space, create_space, manage_space_members -> write:drive. Shared Spaces let you read/contribute files + memory by reference; an editor+ writing a shared file edits the contributor's REAL file.`,
    ``,
    `Rules:`,
    `- Paths are absolute and must start with "/".`,
    `- A path-scoped token only reaches its granted prefix; out-of-scope calls return -32001 "invalid_scope:path:<path>".`,
    `- create_share returns { shareUrl, guideUrl }. Include the guideUrl in any hand-off message so the receiving agent knows how to fetch the share.`,
    ``,
    `Errors: error.message is a colon-delimited code. -32001 = scope (invalid_scope:...), -32602 = bad params (invalid_params:...), -32000 = app error (e.g. file_too_large, quota_exceeded, path_conflict).`,
    `Setup and full machine guide: ${origin}/connect and ${origin}/api/public/guide.`,
  ].join("\n");
  return {
    protocolVersion: "2024-11-05",
    serverInfo: SERVER_INFO,
    capabilities: {
      tools: {},
    },
    instructions,
  };
}

export function createMcpRoutes(options: { sitesIdentity?: boolean } = {}) {
const mcpRoutes = new Hono();
mcpRoutes.post("/", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const runtime = await getPlatform();
  const { db } = runtime;
  const origin = (runtime.vars.get("ALLOWED_ORIGIN") || new URL(c.req.url).origin).replace(/\/+$/u, "");
  const requestOrigin = c.req.header("origin");
  if (requestOrigin) {
    const allowed = new Set([origin, ...(runtime.vars.get("MCP_ALLOWED_ORIGINS") || "").split(",").map((value) => value.trim()).filter(Boolean)]);
    if (!allowed.has(requestOrigin)) return jsonRpcError(null, -32000, "Invalid request Origin", undefined, 403);
  }
  const auth: McpAuthContext | null = options.sitesIdentity && runtime.kind === "sites" && runtime.auth.isAuthenticated()
    ? { kind: "sites", userId: runtime.auth.user.id, clientId: null, scopes: [...DEFAULT_AGENT_TOKEN_SCOPES] }
    : await authenticateMcpBearer(db, c.req.header("authorization"));
  if (!auth) return unauthorized(origin, Boolean(options.sitesIdentity));

  // Gate the MCP surface by the caller's app-level access status, same as REST. A
  // suspended/pending principal must not reach any method dispatch (initialize / tools).
  // The legacy global AGENT_TOKEN on an OWNER_EMAIL-unset deployment has no principal
  // (userId null) — pass through, like the REST gate's trust-any bearer branch. The
  // owner-bound AGENT_TOKEN resolves `active` by owner id and passes.
  if (auth.userId !== null) {
    const denial = await checkAccessGate(db, { id: auth.userId, email: null });
    if (denial) return jsonRpcError(null, -32000, `${denial.code}: ${denial.message}`, undefined, options.sitesIdentity ? 403 : 200);
  }

  const request = (await c.req.json().catch(() => null)) as JsonRpcRequest | null;
  if (!request || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }

  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params) ? request.params as Record<string, unknown> : {};
  const meta = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? params._meta as Record<string, unknown> : {};
  const headerVersion = c.req.header("mcp-protocol-version");
  const metaVersion = meta["io.modelcontextprotocol/protocolVersion"];
  const requested = typeof metaVersion === "string" ? metaVersion : headerVersion;
  if (requested && !MCP_PROTOCOL_VERSIONS.includes(requested as typeof MCP_PROTOCOL_VERSIONS[number])) {
    return jsonRpcError(request.id, -32022, "Unsupported protocol version", { supported: MCP_PROTOCOL_VERSIONS, requested }, 400);
  }
  const modern = requested === "2026-07-28";
  if (modern) {
    let nameHeader = c.req.header("mcp-name");
    if (nameHeader?.startsWith("=?base64?") && nameHeader.endsWith("?=")) {
      try { nameHeader = new TextDecoder().decode(Uint8Array.from(atob(nameHeader.slice(9, -2)), (char) => char.charCodeAt(0))); } catch { nameHeader = undefined; }
    }
    const expectedName = request.method === "tools/call" || request.method === "prompts/get" ? params.name : request.method === "resources/read" ? params.uri : undefined;
    if (headerVersion !== requested || metaVersion !== requested || c.req.header("mcp-method") !== request.method ||
        (expectedName !== undefined && nameHeader !== expectedName)) {
      return jsonRpcError(request.id, -32020, "HeaderMismatch", { reason: "MCP headers must match request metadata and method" }, 400);
    }
    const capabilities = meta["io.modelcontextprotocol/clientCapabilities"];
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      return jsonRpcError(request.id, -32602, "Modern requests require clientCapabilities metadata", undefined, 400);
    }
  } else if (headerVersion && metaVersion && headerVersion !== metaVersion) {
    return jsonRpcError(request.id, -32020, "HeaderMismatch", undefined, 400);
  }
  const result = (value: object, forceModern = modern) => jsonRpcResult(request.id, forceModern
    ? { ...value, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } } : value);
  if (request.method === "server/discover") {
    const initialized = initializeResult(origin, auth);
    return result({ supportedVersions: MCP_PROTOCOL_VERSIONS, serverInfo: SERVER_INFO, capabilities: initialized.capabilities, instructions: initialized.instructions }, true);
  }
  if (!modern && request.method === "initialize") {
    const proposal = typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
    const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(proposal as typeof MCP_PROTOCOL_VERSIONS[number]) && proposal !== "2026-07-28" ? proposal : "2025-11-25";
    return result({ ...initializeResult(origin, auth), protocolVersion });
  }
  if (request.id === undefined && ["notifications/initialized", "notifications/cancelled"].includes(request.method)) return new Response(null, { status: 202 });
  if (!modern && request.method === "ping") return result({});
  if (request.id === undefined) return jsonRpcError(null, -32600, "Unsupported notification", undefined, 400);

  if (request.method === "tools/list") {
    return result({ tools: listMcpTools(auth.scopes), ...(modern ? { ttlMs: 60000, cacheScope: "private" } : {}) });
  }

  if (request.method === "tools/call") {
    if (typeof params.name !== "string") return jsonRpcError(request.id, -32602, "Tool name is required");
    if (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments))) return jsonRpcError(request.id, -32602, "Tool arguments must be an object");
    try {
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
      const output = await callMcpTool(db, origin, auth.scopes, params.name, args, auth.userId);
      let structuredContent: unknown;
      const text = output.content.find((block) => block.type === "text")?.text;
      if (text) { try { structuredContent = JSON.parse(text); } catch { /* preserve text results */ } }
      return result({ ...output, ...(structuredContent !== undefined ? { structuredContent } : {}) });
    } catch (error) {
      // Space helpers (assertSpaceRole/resolveOwnedContributionRef/resolveUserIdByEmail) throw
      // ApiError with a machine code in `.code`; surface it as the colon-prefixed code the MCP
      // error convention uses, so agents see `space_forbidden:...`, not just the prose message.
      const message = error instanceof ApiError
        ? `${error.code}:${error.message}`
        : error instanceof Error
          ? error.message
          : "Tool call failed";
      const code = message.startsWith("invalid_scope:") ? -32001 : message.startsWith("invalid_params:") ? -32602 : -32000;
      return jsonRpcError(request.id, code, message);
    }
  }

  return jsonRpcError(request.id, -32601, `Method not found: ${request.method}`, undefined, modern ? 404 : 200);
});

// GET opens an SSE stream in Streamable HTTP; we do not offer one.
mcpRoutes.get("/", () =>
  methodNotAllowed("This MCP endpoint does not offer an SSE stream. Send JSON-RPC 2.0 messages via POST.")
);

// DELETE terminates a session; we are stateless and issue no Mcp-Session-Id.
mcpRoutes.delete("/", () =>
  methodNotAllowed("This MCP endpoint is stateless and does not support client-initiated session termination.")
);
return mcpRoutes;
}

export const mcpRoutes = createMcpRoutes();
