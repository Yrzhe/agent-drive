import { Hono } from "hono";

import { MCP_SCOPES } from "../lib/mcp-scopes";

export const oauthDiscoveryRoutes = new Hono();

function originFromUrl(url: string): string {
  return new URL(url).origin;
}

oauthDiscoveryRoutes.get("/oauth-protected-resource", (c) => {
  const origin = originFromUrl(c.req.url);
  return c.json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: MCP_SCOPES,
  });
});

oauthDiscoveryRoutes.get("/oauth-authorization-server", (c) => {
  const origin = originFromUrl(c.req.url);
  return c.json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: MCP_SCOPES,
  });
});
