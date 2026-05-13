import { createInterface } from "node:readline";

import { type AgentDriveConfig, readConfig, writeConfig } from "../lib/config.js";
import { refreshAccessToken } from "../lib/oauth.js";
import { normalizeBaseUrl } from "../lib/mcp-client.js";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function mcpEndpoint(url: string): string {
  return `${normalizeBaseUrl(url)}/api/public/mcp`;
}

function emit(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(line: string): void {
  process.stderr.write(`[stdio] ${line}\n`);
}

function parseError(rawLine: string, message: string): void {
  const id = extractId(rawLine);
  emit({
    jsonrpc: "2.0",
    id,
    error: { code: -32700, message: `parse error: ${message}` },
  });
}

function extractId(rawLine: string): string | number | null {
  try {
    const parsed = JSON.parse(rawLine) as JsonRpcMessage;
    if (parsed && (typeof parsed.id === "string" || typeof parsed.id === "number")) {
      return parsed.id;
    }
  } catch {
    // ignore
  }
  return null;
}

function isRefreshable(config: AgentDriveConfig): boolean {
  return config.tokenType === "oauth_access_token" && Boolean(config.clientId && config.refreshToken);
}

async function refreshTokenIfPossible(config: AgentDriveConfig): Promise<boolean> {
  if (!isRefreshable(config)) return false;
  try {
    const token = await refreshAccessToken({
      baseUrl: config.url,
      clientId: config.clientId!,
      refreshToken: config.refreshToken!,
      scope: config.scope,
    });
    config.token = token.access_token;
    config.refreshToken = token.refresh_token ?? config.refreshToken;
    config.expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
    config.scope = token.scope ?? config.scope;
    await writeConfig(config);
    log("token refreshed");
    return true;
  } catch (error) {
    log(`token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function forward(config: AgentDriveConfig, body: string): Promise<{ status: number; body: string }> {
  const response = await fetch(mcpEndpoint(config.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "authorization": `Bearer ${config.token}`,
    },
    body,
  });
  const text = await response.text();
  return { status: response.status, body: text };
}

async function handleLine(config: AgentDriveConfig, rawLine: string): Promise<void> {
  const trimmed = rawLine.trim();
  if (!trimmed) return;

  let message: JsonRpcMessage;
  try {
    message = JSON.parse(trimmed) as JsonRpcMessage;
  } catch (error) {
    parseError(trimmed, error instanceof Error ? error.message : String(error));
    return;
  }

  const id = (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
  const method = typeof message.method === "string" ? message.method : "<unknown>";
  const isNotification = message.id === undefined;
  log(`-> ${method}${isNotification ? " (notification)" : ""}`);

  try {
    let result = await forward(config, trimmed);
    if (result.status === 401 && isRefreshable(config)) {
      const refreshed = await refreshTokenIfPossible(config);
      if (refreshed) {
        result = await forward(config, trimmed);
      }
    }

    log(`<- ${result.status} (${result.body.length} bytes)`);

    if (isNotification) return;

    if (!result.body) {
      emit({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `HTTP ${result.status} empty response` },
      });
      return;
    }

    // Pass remote JSON-RPC response straight through (preserves original id).
    process.stdout.write(`${result.body.endsWith("\n") ? result.body : `${result.body}\n`}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`<- network error: ${detail}`);
    if (isNotification) return;
    emit({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `network error: ${detail}` },
    });
  }
}

export async function mcpStdioCommand(): Promise<void> {
  const config = await readConfig();
  if (!config) {
    throw new Error("Not logged in. Run: adrive login --url <URL>");
  }

  log(`bridge online → ${config.url}`);

  const rl = createInterface({ input: process.stdin });
  const queue: Promise<void> = Promise.resolve();
  let chain = queue;

  rl.on("line", (line) => {
    chain = chain.then(() => handleLine(config, line)).catch((error) => {
      log(`handler crashed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  await new Promise<void>((resolve) => {
    rl.once("close", () => {
      log("stdin closed");
      resolve();
    });
  });

  await chain;
}
