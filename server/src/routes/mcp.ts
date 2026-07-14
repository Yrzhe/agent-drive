import { Hono } from "hono";

import { authenticateMcpBearer, type McpAuthContext } from "../lib/mcp-auth";
import { callMcpTool, listMcpTools } from "../lib/mcp-tools";

export const mcpRoutes = new Hono();

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function unauthorized(origin: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/api/public/.well-known/oauth-protected-resource"`,
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
    `- create_share, send_file -> share:create`,
    `- remember, recall, list_memories, forget -> read:memory / write:memory`,
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
    serverInfo: {
      name: "agent-drive",
      version: "0.1.0",
    },
    capabilities: {
      tools: {},
    },
    instructions,
  };
}

mcpRoutes.post("/", async (c) => {
  const origin = new URL(c.req.url).origin;
  const { db } = await import("edgespark");
  const auth = await authenticateMcpBearer(db, c.req.header("authorization"));
  if (!auth) return unauthorized(origin);

  const request = (await c.req.json().catch(() => null)) as JsonRpcRequest | null;
  if (!request || request.jsonrpc !== "2.0" || !request.method) {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }

  if (request.method === "initialize") {
    return jsonRpcResult(request.id, initializeResult(origin, auth));
  }

  if (request.method === "tools/list") {
    return jsonRpcResult(request.id, { tools: listMcpTools(auth.scopes) });
  }

  if (request.method === "tools/call") {
    const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== "string") return jsonRpcError(request.id, -32602, "Tool name is required");
    try {
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
      const result = await callMcpTool(db, origin, auth.scopes, params.name, args);
      return jsonRpcResult(request.id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool call failed";
      const code = message.startsWith("invalid_scope:") ? -32001 : message.startsWith("invalid_params:") ? -32602 : -32000;
      return jsonRpcError(request.id, code, message);
    }
  }

  return jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
});
