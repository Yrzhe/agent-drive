import { and, eq, isNull } from "drizzle-orm";

import { oauthTokens } from "@defs";

import { parseBearerToken, timingSafeEqualStrings, verifyPasswordHash } from "./crypto";
import { DEFAULT_AGENT_TOKEN_SCOPES, isMcpScope, isPathScope, normalizeScopes, parsePathScope } from "./mcp-scopes";
import { resolveOwnerUserId } from "./owner";
import type { AppDb } from "../types";

export interface McpAuthContext {
  kind: "oauth" | "agent_token";
  userId: string | null;
  clientId: string | null;
  /**
   * Granted scopes. Includes both capability scopes ("read:drive", etc.) and
   * any path:/<prefix>/* scopes attached at consent time. Use mcp-scopes
   * helpers (hasScope / pathAllowed) instead of inspecting the strings.
   */
  scopes: string[];
}

function splitSecretToken(token: string): { id: string; secret: string } | null {
  const index = token.indexOf(".");
  if (index <= 0 || index === token.length - 1) return null;
  return { id: token.slice(0, index), secret: token.slice(index + 1) };
}

const AGENT_TOKEN_ALLOWED_CAPABILITY_SCOPES: Set<string> = new Set(DEFAULT_AGENT_TOKEN_SCOPES.filter((scope) => isMcpScope(scope)));

function agentTokenScopes(configuredScopes: string | null | undefined): string[] {
  if (!configuredScopes?.trim()) return [...DEFAULT_AGENT_TOKEN_SCOPES];

  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const token of configuredScopes.split(/\s+/u)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (isMcpScope(trimmed)) {
      if (!AGENT_TOKEN_ALLOWED_CAPABILITY_SCOPES.has(trimmed)) return [];
    } else if (!isPathScope(trimmed) || parsePathScope(trimmed) === null) {
      return [];
    }

    const [normalized] = normalizeScopes(trimmed);
    if (!normalized) return [];
    if (!seen.has(normalized)) {
      scopes.push(normalized);
      seen.add(normalized);
    }
  }
  return scopes;
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

  const { secret, vars } = await import("edgespark");
  const configured = secret.get("AGENT_TOKEN");
  if (configured && timingSafeEqualStrings(bearer, configured)) {
    // The deployment-wide token has no identity of its own; bind it to the owner so
    // every accepted request carries a non-null owner (Phase 0).
    const ownerUserId = await resolveOwnerUserId(db);
    const ownerEmailConfigured = Boolean(vars.get("OWNER_EMAIL")?.trim());
    if (ownerUserId === null && ownerEmailConfigured) {
      // resolveOwnerUserId returns null for two different reasons: OWNER_EMAIL unset
      // (legacy trust-any, handled below) or OWNER_EMAIL set but unresolved (no
      // matching row, or an ambiguous case-only-duplicate). Per owner.ts's documented
      // fail-closed contract, the latter must NEVER fall through to trust-any — that
      // would silently expose the whole drive to a token holder when the deployment
      // owner believed isolation was armed. Reject the token outright.
      return null;
    }
    return {
      kind: "agent_token",
      // Null here only means a legacy deployment with OWNER_EMAIL unset — the
      // fail-closed case above already rejected the set-but-unresolved case.
      userId: ownerUserId,
      clientId: null,
      scopes: agentTokenScopes(vars.get("AGENT_TOKEN_SCOPES")),
    };
  }

  return null;
}
