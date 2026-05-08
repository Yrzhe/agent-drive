import { Hono } from "hono";

import { MCP_SCOPES } from "../lib/mcp-scopes";

export const oauthDiscoveryRoutes = new Hono();

const API_PUBLIC_BASE = "/api/public";
const OAUTH_METADATA_PATH = `${API_PUBLIC_BASE}/.well-known/oauth-authorization-server`;

async function originFromRequest(url: string): Promise<string> {
  const { vars } = await import("edgespark");
  return (vars.get("ALLOWED_ORIGIN") ?? new URL(url).origin).replace(/\/+$/u, "");
}

oauthDiscoveryRoutes.get("/oauth-protected-resource", async (c) => {
  const origin = await originFromRequest(c.req.url);
  const authorizationServer = `${origin}${OAUTH_METADATA_PATH}`;
  return c.json({
    resource: `${origin}${API_PUBLIC_BASE}/mcp`,
    authorization_servers: [authorizationServer],
    bearer_methods_supported: ["header"],
    scopes_supported: MCP_SCOPES,
  });
});

oauthDiscoveryRoutes.get("/oauth-authorization-server", async (c) => {
  const origin = await originFromRequest(c.req.url);
  const authorizationServer = `${origin}${OAUTH_METADATA_PATH}`;
  return c.json({
    issuer: authorizationServer,
    authorization_endpoint: `${origin}${API_PUBLIC_BASE}/oauth/authorize`,
    token_endpoint: `${origin}${API_PUBLIC_BASE}/oauth/token`,
    registration_endpoint: `${origin}${API_PUBLIC_BASE}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: MCP_SCOPES,
  });
});
