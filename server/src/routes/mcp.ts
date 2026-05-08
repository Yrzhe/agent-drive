import { Hono } from "hono";

import { authenticateMcpBearer, type McpAuthContext } from "../lib/mcp-auth";

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
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  });
}

function initializeResult(origin: string, auth: McpAuthContext) {
  return {
    protocolVersion: "2025-03-26",
    serverInfo: {
      name: "agent-drive",
      version: "0.1.0",
    },
    capabilities: {
      tools: {},
    },
    instructions: `Connected to Agent Drive MCP at ${origin}. Auth mode: ${auth.kind}.`,
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
    return jsonRpcResult(request.id, { tools: [] });
  }

  if (request.method === "tools/call") {
    return jsonRpcError(request.id, -32601, "No MCP tools are registered yet");
  }

  return jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
});
