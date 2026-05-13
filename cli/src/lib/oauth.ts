import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import type { AddressInfo } from "node:net";

import { normalizeBaseUrl } from "./mcp-client.js";

export const DEFAULT_OAUTH_SCOPE = "read:drive write:drive share:create";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface OAuthClientRegistration {
  client_id: string;
  scope?: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export interface CallbackListener {
  port: number;
  waitFor: () => Promise<URL>;
  close: () => Promise<void>;
}

export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return randomBytes(16).toString("hex");
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authServerUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

function jsonHeaders(): HeadersInit {
  return { "content-type": "application/json" };
}

function safeClientName(): string {
  const name = `adrive CLI on ${hostname()}`.replace(/[^\x20-\x7E]/gu, "").slice(0, 64);
  return name || "adrive CLI";
}

async function readJsonResponse<T>(response: Response, label: string): Promise<T> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`${label} failed: HTTP ${response.status}`);
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } }).error;
    throw new Error(`${label} failed: HTTP ${response.status}${error?.message ? ` ${error.message}` : ""}`);
  }
  return parsed as T;
}

export async function registerOAuthClient(baseUrl: string, redirectUri: string, scope: string): Promise<OAuthClientRegistration> {
  const response = await fetch(authServerUrl(baseUrl, "/api/public/oauth/register"), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      client_name: safeClientName(),
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    }),
  });
  return readJsonResponse<OAuthClientRegistration>(response, "OAuth registration");
}

export async function exchangeAuthorizationCode(input: {
  baseUrl: string;
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<OAuthTokenResponse> {
  const response = await fetch(authServerUrl(input.baseUrl, "/api/public/oauth/token"), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    }),
  });
  return readJsonResponse<OAuthTokenResponse>(response, "OAuth token exchange");
}

export async function refreshAccessToken(input: {
  baseUrl: string;
  clientId: string;
  refreshToken: string;
  scope?: string;
}): Promise<OAuthTokenResponse> {
  const response = await fetch(authServerUrl(input.baseUrl, "/api/public/oauth/token"), {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      ...(input.scope ? { scope: input.scope } : {}),
    }),
  });
  return readJsonResponse<OAuthTokenResponse>(response, "OAuth token refresh");
}

function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

export async function startCallbackListener(timeoutMs = 5 * 60 * 1000): Promise<CallbackListener> {
  let settled = false;
  let resolveUrl!: (url: URL) => void;
  let rejectUrl!: (error: Error) => void;
  const waitPromise = new Promise<URL>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/callback") {
      writeHtml(response, 404, "Not found");
      return;
    }
    if (settled) {
      writeHtml(response, 409, "Authorization already handled.");
      return;
    }
    settled = true;
    writeHtml(response, 200, "<!doctype html><title>Agent Drive Authorized</title><h1>Authorization successful</h1><p>You can close this tab.</p>");
    resolveUrl(requestUrl);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectUrl(new Error("Authorization timed out. Run login again."));
      void closeServer(server);
    }
  }, timeoutMs);

  const close = async () => {
    clearTimeout(timeout);
    await closeServer(server);
  };

  return {
    port: (server.address() as AddressInfo).port,
    waitFor: async () => {
      try {
        return await waitPromise;
      } finally {
        await close();
      }
    },
    close,
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
