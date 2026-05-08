import { and, eq, isNull, lt } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { oauthAuthorizationCodes, oauthClients, oauthTokens } from "@defs";

import { hashPassword, verifyPasswordHash } from "../lib/crypto";
import { nowIso } from "../lib/files";
import { DEFAULT_MCP_SCOPES, filterAllowedScopes, FULL_MCP_SCOPES, normalizeScopes, parseScopeParam, scopeDescriptions, serializeScopes } from "../lib/mcp-scopes";
import { checkRateLimit, recordFailure } from "../lib/rate-limit";
import { ApiError, withErrorHandling } from "../lib/errors";

export const oauthRoutes = new Hono();

const OAUTH_REGISTER_RATE_LIMIT_MAX = 20;
const OAUTH_REGISTER_RATE_LIMIT_MS = 60 * 60 * 1000;
const OAUTH_TOKEN_RATE_LIMIT_MAX = 20;
const OAUTH_TOKEN_RATE_LIMIT_MS = 15 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 30 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function requestIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

function parseRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ApiError(400, "invalid_client_metadata", "redirect_uris must be an array");
  const redirectUris = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (redirectUris.length === 0) throw new ApiError(400, "invalid_client_metadata", "redirect_uris must contain at least one URI");
  for (const redirectUri of redirectUris) {
    try {
      new URL(redirectUri);
    } catch {
      throw new ApiError(400, "invalid_redirect_uri", "redirect_uris must contain valid absolute URIs");
    }
  }
  return [...new Set(redirectUris)];
}

function parseStoredRedirectUris(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function assertExactRedirectUri(client: typeof oauthClients.$inferSelect, redirectUri: string): void {
  const redirectUris = parseStoredRedirectUris(client.redirectUris);
  if (!redirectUris.includes(redirectUri)) {
    throw new ApiError(400, "invalid_redirect_uri", "redirect_uri must exactly match a registered URI");
  }
}

function assertPkceS256(method: string | null, challenge: string | null): void {
  if (method !== "S256") throw new ApiError(400, "invalid_request", "code_challenge_method must be S256");
  if (!challenge) throw new ApiError(400, "invalid_request", "code_challenge is required");
}

async function readBody(c: { req: { header: (name: string) => string | undefined; json: () => Promise<unknown>; text: () => Promise<string> } }): Promise<Record<string, string>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value : String(value ?? "")]));
  }
  const text = await c.req.text();
  return Object.fromEntries(new URLSearchParams(text).entries());
}

function splitSecretToken(token: string | undefined): { id: string; secret: string } | null {
  if (!token) return null;
  const index = token.indexOf(".");
  if (index <= 0 || index === token.length - 1) return null;
  return { id: token.slice(0, index), secret: token.slice(index + 1) };
}

function generateSecretToken(prefix: string): { id: string; token: string; secret: string } {
  const id = `${prefix}_${nanoid(24)}`;
  const secret = nanoid(48);
  return { id, secret, token: `${id}.${secret}` };
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest) === challenge;
}

async function assertClientSecret(client: typeof oauthClients.$inferSelect, clientSecret: string | undefined): Promise<void> {
  if (!client.clientSecretHash) return;
  if (!clientSecret || !(await verifyPasswordHash(clientSecret, client.clientSecretHash))) {
    throw new ApiError(401, "invalid_client", "Invalid client credentials");
  }
}

async function issueTokenPair(input: { clientId: string; userId: string; scope: string }) {
  const access = generateSecretToken("atk");
  const refresh = generateSecretToken("rtk");
  return {
    access,
    refresh,
    row: {
      id: access.id,
      accessTokenHash: await hashPassword(access.secret),
      refreshTokenHash: await hashPassword(refresh.secret),
      clientId: input.clientId,
      userId: input.userId,
      scope: input.scope,
      expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString(),
      refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
      createdAt: nowIso(),
      revokedAt: null,
    },
  };
}

oauthRoutes.post(
  "/register",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const rateLimitKey = `oauth-register:${requestIp(c)}`;
    const limitState = await checkRateLimit(db, rateLimitKey, OAUTH_REGISTER_RATE_LIMIT_MAX, OAUTH_REGISTER_RATE_LIMIT_MS);
    if (!limitState.allowed) {
      throw new ApiError(429, "too_many_attempts", "Too many client registration attempts");
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      redirect_uris?: unknown;
      client_name?: unknown;
      scope?: unknown;
      token_endpoint_auth_method?: unknown;
    };

    const redirectUris = parseRedirectUris(body.redirect_uris);
    const clientName = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim() : null;
    const requestedScopes = parseScopeParam(typeof body.scope === "string" ? body.scope : null);
    const allowedScopes = filterAllowedScopes(requestedScopes.length > 0 ? requestedScopes : DEFAULT_MCP_SCOPES, FULL_MCP_SCOPES);
    const tokenEndpointAuthMethod = body.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none";
    const clientId = `ad_${nanoid(24)}`;
    const clientSecret = tokenEndpointAuthMethod === "client_secret_post" ? `ads_${nanoid(40)}` : null;

    try {
      await db.insert(oauthClients).values({
        id: clientId,
        clientSecretHash: clientSecret ? await hashPassword(clientSecret) : null,
        redirectUris: JSON.stringify(redirectUris),
        clientName,
        scopeDefault: serializeScopes(allowedScopes),
        registeredAt: nowIso(),
        lastUsedAt: null,
      });
    } catch (error) {
      await recordFailure(db, rateLimitKey, OAUTH_REGISTER_RATE_LIMIT_MS);
      throw error;
    }

    const origin = new URL(c.req.url).origin;
    return c.json({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: clientName,
      scope: serializeScopes(allowedScopes),
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
    }, 201);
  })
);

oauthRoutes.get(
  "/authorize",
  withErrorHandling(async (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const responseType = c.req.query("response_type") ?? "";
    const codeChallenge = c.req.query("code_challenge") ?? null;
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? null;
    if (responseType !== "code") throw new ApiError(400, "unsupported_response_type", "response_type must be code");
    assertPkceS256(codeChallengeMethod, codeChallenge);

    const { db } = await import("edgespark");
    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
    if (!client) throw new ApiError(400, "invalid_client", "Unknown client_id");
    assertExactRedirectUri(client, redirectUri);

    const allowedScopes = normalizeScopes(client.scopeDefault);
    const requestedScopes = filterAllowedScopes(parseScopeParam(c.req.query("scope") ?? client.scopeDefault), allowedScopes.length > 0 ? allowedScopes : FULL_MCP_SCOPES);
    const params = new URLSearchParams({
      client_id: client.id,
      client_name: client.clientName ?? "Agent Drive MCP Client",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: serializeScopes(requestedScopes),
      code_challenge: codeChallenge ?? "",
      code_challenge_method: "S256",
    });
    const state = c.req.query("state");
    if (state) params.set("state", state);
    return c.redirect(`/connect/authorize?${params.toString()}`);
  })
);

oauthRoutes.post(
  "/authorize/consent",
  withErrorHandling(async (c) => {
    const { auth } = await import("edgespark/http");
    if (!auth.isAuthenticated()) throw new ApiError(401, "unauthorized", "Sign in before authorizing this client");

    const body = await readBody(c);
    if (body.approved === "false") throw new ApiError(403, "access_denied", "User denied consent");
    assertPkceS256(body.code_challenge_method ?? null, body.code_challenge ?? null);

    const { db } = await import("edgespark");
    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, body.client_id ?? "")).limit(1);
    if (!client) throw new ApiError(400, "invalid_client", "Unknown client_id");
    const redirectUri = body.redirect_uri ?? "";
    assertExactRedirectUri(client, redirectUri);

    const allowedScopes = normalizeScopes(client.scopeDefault);
    const grantedScopes = filterAllowedScopes(parseScopeParam(body.scope ?? client.scopeDefault), allowedScopes.length > 0 ? allowedScopes : FULL_MCP_SCOPES);
    const code = generateSecretToken("code");
    await db.insert(oauthAuthorizationCodes).values({
      codeHash: `${code.id}:${await hashPassword(code.secret)}`,
      clientId: client.id,
      userId: auth.user.id,
      scope: serializeScopes(grantedScopes),
      pkceChallenge: body.code_challenge ?? "",
      pkceMethod: "S256",
      redirectUri,
      expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
      usedAt: null,
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code.token);
    if (body.state) redirect.searchParams.set("state", body.state);
    return c.json({
      redirect_uri: redirect.toString(),
      code: code.token,
      scope: serializeScopes(grantedScopes),
      scopes: scopeDescriptions(grantedScopes),
    });
  })
);

oauthRoutes.post(
  "/token",
  withErrorHandling(async (c) => {
    const body = await readBody(c);
    const { db } = await import("edgespark");
    const rateLimitKey = `oauth-token:${requestIp(c)}:${body.client_id ?? "unknown"}`;
    const limitState = await checkRateLimit(db, rateLimitKey, OAUTH_TOKEN_RATE_LIMIT_MAX, OAUTH_TOKEN_RATE_LIMIT_MS);
    if (!limitState.allowed) throw new ApiError(429, "too_many_attempts", "Too many token attempts");

    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, body.client_id ?? "")).limit(1);
    if (!client) throw new ApiError(401, "invalid_client", "Unknown client_id");
    await assertClientSecret(client, body.client_secret);

    if (body.grant_type === "authorization_code") {
      const codeToken = splitSecretToken(body.code);
      if (!codeToken) throw new ApiError(400, "invalid_grant", "Invalid authorization code");
      const codeRows = await db.select().from(oauthAuthorizationCodes).where(and(eq(oauthAuthorizationCodes.clientId, client.id), isNull(oauthAuthorizationCodes.usedAt)));
      const codeRow = (await Promise.all(codeRows.map(async (row) => ({ row, tokenId: row.codeHash.split(":")[0], valid: row.codeHash.startsWith(`${codeToken.id}:`) && await verifyPasswordHash(codeToken.secret, row.codeHash.slice(row.codeHash.indexOf(":") + 1)) }))))
        .find((candidate) => candidate.tokenId === codeToken.id && candidate.valid)?.row;
      if (!codeRow || Date.parse(codeRow.expiresAt) <= Date.now()) {
        await recordFailure(db, rateLimitKey, OAUTH_TOKEN_RATE_LIMIT_MS);
        throw new ApiError(400, "invalid_grant", "Authorization code is invalid or expired");
      }
      if (codeRow.redirectUri !== body.redirect_uri) throw new ApiError(400, "invalid_grant", "redirect_uri mismatch");
      if (!body.code_verifier || !(await verifyPkceS256(body.code_verifier, codeRow.pkceChallenge))) {
        await recordFailure(db, rateLimitKey, OAUTH_TOKEN_RATE_LIMIT_MS);
        throw new ApiError(400, "invalid_grant", "PKCE verification failed");
      }

      const issued = await issueTokenPair({ clientId: client.id, userId: codeRow.userId, scope: codeRow.scope });
      await db.batch([
        db.update(oauthAuthorizationCodes).set({ usedAt: nowIso() }).where(eq(oauthAuthorizationCodes.codeHash, codeRow.codeHash)),
        db.insert(oauthTokens).values(issued.row),
        db.update(oauthClients).set({ lastUsedAt: nowIso() }).where(eq(oauthClients.id, client.id)),
      ]);
      return c.json({
        access_token: issued.access.token,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: issued.refresh.token,
        scope: codeRow.scope,
      });
    }

    if (body.grant_type === "refresh_token") {
      const refreshToken = splitSecretToken(body.refresh_token);
      if (!refreshToken) throw new ApiError(400, "invalid_grant", "Invalid refresh token");
      const tokenRows = await db.select().from(oauthTokens).where(and(eq(oauthTokens.clientId, client.id), isNull(oauthTokens.revokedAt)));
      const tokenRow = (await Promise.all(tokenRows.map(async (row) => ({
        row,
        valid: row.refreshTokenHash ? await verifyPasswordHash(refreshToken.secret, row.refreshTokenHash) : false,
      })))).find((candidate) => candidate.valid)?.row;
      if (!tokenRow?.refreshTokenHash || !tokenRow.refreshExpiresAt || Date.parse(tokenRow.refreshExpiresAt) <= Date.now() || !(await verifyPasswordHash(refreshToken.secret, tokenRow.refreshTokenHash))) {
        await recordFailure(db, rateLimitKey, OAUTH_TOKEN_RATE_LIMIT_MS);
        throw new ApiError(400, "invalid_grant", "Refresh token is invalid or expired");
      }
      const issued = await issueTokenPair({ clientId: client.id, userId: tokenRow.userId, scope: tokenRow.scope });
      await db.batch([
        db.update(oauthTokens).set({ revokedAt: nowIso() }).where(eq(oauthTokens.id, tokenRow.id)),
        db.insert(oauthTokens).values(issued.row),
        db.update(oauthClients).set({ lastUsedAt: nowIso() }).where(eq(oauthClients.id, client.id)),
      ]);
      return c.json({
        access_token: issued.access.token,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: issued.refresh.token,
        scope: tokenRow.scope,
      });
    }

    throw new ApiError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  })
);

oauthRoutes.get(
  "/clients/:clientId",
  withErrorHandling(async (c) => {
    const clientId = c.req.param("clientId");
    if (!clientId) throw new ApiError(400, "invalid_request", "clientId is required");
    const { db } = await import("edgespark");
    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
    if (!client) throw new ApiError(404, "client_not_found", "OAuth client not found");
    return c.json({
      client_id: client.id,
      client_name: client.clientName,
      redirect_uris: JSON.parse(client.redirectUris) as string[],
      scope: client.scopeDefault,
      token_endpoint_auth_method: client.clientSecretHash ? "client_secret_post" : "none",
    });
  })
);
