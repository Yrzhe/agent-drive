import { Hono } from "hono";

import { checkAccessGate } from "../lib/access";
import { ApiError } from "../lib/errors";
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

  // Gate the MCP surface by the caller's app-level access status, same as REST. A
  // suspended/pending principal must not reach any method dispatch (initialize / tools).
  // The legacy global AGENT_TOKEN on an OWNER_EMAIL-unset deployment has no principal
  // (userId null) — pass through, like the REST gate's trust-any bearer branch. The
  // owner-bound AGENT_TOKEN resolves `active` by owner id and passes.
  if (auth.userId !== null) {
    const denial = await checkAccessGate(db, { id: auth.userId, email: null });
    if (denial) return jsonRpcError(null, -32000, `${denial.code}: ${denial.message}`);
  }

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
      const result = await callMcpTool(db, origin, auth.scopes, params.name, args, auth.userId);
      return jsonRpcResult(request.id, result);
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

  return jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
});

// GET opens an SSE stream in Streamable HTTP; we do not offer one.
mcpRoutes.get("/", () =>
  methodNotAllowed("This MCP endpoint does not offer an SSE stream. Send JSON-RPC 2.0 messages via POST.")
);

// DELETE terminates a session; we are stateless and issue no Mcp-Session-Id.
mcpRoutes.delete("/", () =>
  methodNotAllowed("This MCP endpoint is stateless and does not support client-initiated session termination.")
);
