import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { oauthClients } from "@defs";

import { hashPassword } from "../lib/crypto";
import { nowIso } from "../lib/files";
import { DEFAULT_MCP_SCOPES, filterAllowedScopes, FULL_MCP_SCOPES, parseScopeParam, serializeScopes } from "../lib/mcp-scopes";
import { checkRateLimit, recordFailure } from "../lib/rate-limit";
import { ApiError, withErrorHandling } from "../lib/errors";

export const oauthRoutes = new Hono();

const OAUTH_REGISTER_RATE_LIMIT_MAX = 20;
const OAUTH_REGISTER_RATE_LIMIT_MS = 60 * 60 * 1000;

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
