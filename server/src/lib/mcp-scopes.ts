export const MCP_SCOPES = [
  "read:drive",
  "write:drive",
  "read:memory",
  "write:memory",
  "read:skills",
  "write:skills",
  "share:create",
] as const;

export type McpScope = typeof MCP_SCOPES[number];

export const DEFAULT_MCP_SCOPES: McpScope[] = ["read:drive"];
export const FULL_MCP_SCOPES: McpScope[] = [...MCP_SCOPES];

const SCOPE_DESCRIPTIONS: Record<McpScope, string> = {
  "read:drive": "Read files and folders in Agent Drive",
  "write:drive": "Create and update files and folders in Agent Drive",
  "read:memory": "Read memory files stored in Agent Drive",
  "write:memory": "Create and update memory files stored in Agent Drive",
  "read:skills": "Read skill files stored in Agent Drive",
  "write:skills": "Create and update skill files stored in Agent Drive",
  "share:create": "Create share links for files and folders",
};

const SCOPE_SET = new Set<string>(MCP_SCOPES);

export function normalizeScopes(input?: string | string[] | null): McpScope[] {
  const raw = Array.isArray(input) ? input : (input ?? "").split(/\s+/);
  const scopes = raw.map((scope) => scope.trim()).filter(Boolean);
  return [...new Set(scopes.filter((scope): scope is McpScope => SCOPE_SET.has(scope)))];
}

export function parseScopeParam(input?: string | null): McpScope[] {
  const requested = normalizeScopes(input);
  return requested.length > 0 ? requested : DEFAULT_MCP_SCOPES;
}

export function serializeScopes(scopes: readonly McpScope[]): string {
  return [...new Set(scopes)].join(" ");
}

export function hasScope(grantedScopes: readonly string[], requiredScope: McpScope): boolean {
  return grantedScopes.includes(requiredScope);
}

export function requireScope(grantedScopes: readonly string[], requiredScope: McpScope): void {
  if (!hasScope(grantedScopes, requiredScope)) {
    throw new Error(`invalid_scope:${requiredScope}`);
  }
}

export function scopeDescriptions(scopes: readonly McpScope[]): Array<{ scope: McpScope; description: string }> {
  return scopes.map((scope) => ({ scope, description: SCOPE_DESCRIPTIONS[scope] }));
}

export function filterAllowedScopes(requestedScopes: readonly McpScope[], allowedScopes: readonly McpScope[]): McpScope[] {
  const allowed = new Set(allowedScopes);
  return requestedScopes.filter((scope) => allowed.has(scope));
}
