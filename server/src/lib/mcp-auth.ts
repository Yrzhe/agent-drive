import { and, eq, isNull } from "drizzle-orm";

import { oauthTokens } from "@defs";

import { parseBearerToken, timingSafeEqualStrings, verifyPasswordHash } from "./crypto";
import { FULL_MCP_SCOPES, normalizeScopes, type McpScope } from "./mcp-scopes";
import type { AppDb } from "../types";

export interface McpAuthContext {
  kind: "oauth" | "agent_token";
  userId: string | null;
  clientId: string | null;
  scopes: McpScope[];
}

function splitSecretToken(token: string): { id: string; secret: string } | null {
  const index = token.indexOf(".");
  if (index <= 0 || index === token.length - 1) return null;
  return { id: token.slice(0, index), secret: token.slice(index + 1) };
}

export async function authenticateMcpBearer(db: AppDb, authorization: string | undefined): Promise<McpAuthContext | null> {
  const bearer = parseBearerToken(authorization);
  if (!bearer) return null;

  const split = splitSecretToken(bearer);
  if (split) {
    const [tokenRow] = await db.select().from(oauthTokens).where(and(eq(oauthTokens.id, split.id), isNull(oauthTokens.revokedAt))).limit(1);
    if (tokenRow && Date.parse(tokenRow.expiresAt) > Date.now() && await verifyPasswordHash(split.secret, tokenRow.accessTokenHash)) {
      return {
        kind: "oauth",
        userId: tokenRow.userId,
        clientId: tokenRow.clientId,
        scopes: normalizeScopes(tokenRow.scope),
      };
    }
  }

  const { secret } = await import("edgespark");
  const configured = secret.get("AGENT_TOKEN");
  if (configured && timingSafeEqualStrings(bearer, configured)) {
    return {
      kind: "agent_token",
      userId: null,
      clientId: null,
      scopes: FULL_MCP_SCOPES,
    };
  }

  return null;
}
