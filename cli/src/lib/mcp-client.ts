import { type AgentDriveConfig, writeConfig } from "./config.js";
import { refreshAccessToken } from "./oauth.js";

export interface McpClientOptions {
  url: string;
  token: string;
  tokenType?: "agent_token" | "oauth_access_token";
  clientId?: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  machineId?: string;
  createdAt?: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: {
    name: string;
    version: string;
  };
}

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: {
    code?: number;
    message?: string;
  };
}

export class McpToolError extends Error {
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
  }
}

export function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/u, "");
}

function mcpEndpoint(url: string): string {
  return `${normalizeBaseUrl(url)}/api/public/mcp`;
}

export function apiUrl(options: McpClientOptions, path: string): string {
  return `${normalizeBaseUrl(options.url)}${path}`;
}

function oauthExpiresSoon(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - Date.now() < 60 * 1000;
}

function isRefreshable(options: McpClientOptions): options is McpClientOptions & Required<Pick<McpClientOptions, "clientId" | "refreshToken">> {
  return options.tokenType === "oauth_access_token" && Boolean(options.clientId && options.refreshToken);
}

async function refreshIfNeeded(options: McpClientOptions, force = false): Promise<void> {
  if (!isRefreshable(options)) return;
  if (!force && !oauthExpiresSoon(options.expiresAt)) return;
  try {
    const token = await refreshAccessToken({
      baseUrl: options.url,
      clientId: options.clientId,
      refreshToken: options.refreshToken,
      scope: options.scope,
    });
    const next: McpClientOptions = {
      ...options,
      token: token.access_token,
      refreshToken: token.refresh_token ?? options.refreshToken,
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      scope: token.scope ?? options.scope,
    };
    if (next.machineId && next.createdAt) {
      await writeConfig(next as AgentDriveConfig);
    }
    // Disk write succeeded — only now mutate the in-memory options so a
    // partial failure can't leave callers using a token that was never persisted.
    Object.assign(options, next);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Session expired (${detail}). Run: adrive login --url ${options.url}`);
  }
}

async function sendJsonRpc<T>(options: McpClientOptions, method: string, params?: unknown): Promise<{ response: Response; payload: JsonRpcResponse<T> | null }> {
  const response = await fetch(mcpEndpoint(options.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${options.token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });

  const text = await response.text();
  let payload: JsonRpcResponse<T> | null = null;
  try {
    payload = text ? JSON.parse(text) as JsonRpcResponse<T> : null;
  } catch {
    throw new Error(`MCP ${method} failed: HTTP ${response.status} non-JSON response`);
  }
  return { response, payload };
}

async function postJsonRpc<T>(options: McpClientOptions, method: string, params?: unknown): Promise<T> {
  await refreshIfNeeded(options);
  let { response, payload } = await sendJsonRpc<T>(options, method, params);
  if (response.status === 401 && isRefreshable(options)) {
    await refreshIfNeeded(options, true);
    ({ response, payload } = await sendJsonRpc<T>(options, method, params));
  }

  if (!response.ok) {
    throw new Error(`MCP ${method} failed: HTTP ${response.status}${payload?.error?.message ? ` ${payload.error.message}` : ""}`);
  }
  if (payload?.error) {
    throw new McpToolError(payload.error.message ?? `MCP ${method} failed`, payload.error.code);
  }
  if (!payload?.result) {
    throw new Error(`MCP ${method} failed: missing result`);
  }
  return payload.result;
}

export async function authorizationHeader(options: McpClientOptions): Promise<string> {
  await refreshIfNeeded(options);
  return `Bearer ${options.token}`;
}

export async function initializeMcp(options: McpClientOptions): Promise<McpInitializeResult> {
  const result = await postJsonRpc<McpInitializeResult>(options, "initialize");
  if (
    !result.protocolVersion ||
    !result.serverInfo ||
    typeof result.serverInfo.name !== "string" ||
    typeof result.serverInfo.version !== "string"
  ) {
    throw new Error("MCP initialize failed: invalid serverInfo response");
  }
  return result;
}

export async function callTool<T = unknown>(options: McpClientOptions, name: string, args: Record<string, unknown>): Promise<T> {
  return postJsonRpc<T>(options, "tools/call", { name, arguments: args });
}

export async function readFileTool(options: McpClientOptions, path: string): Promise<unknown> {
  return callTool(options, "read_file", { path });
}

export async function writeFileTool(options: McpClientOptions, path: string, content: string): Promise<unknown> {
  return callTool(options, "write_file", { path, content });
}
