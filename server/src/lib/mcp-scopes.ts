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

const PATH_SCOPE_PREFIX = "path:";

export function isMcpScope(value: string): value is McpScope {
  return SCOPE_SET.has(value);
}

export function isPathScope(value: string): boolean {
  return value.startsWith(PATH_SCOPE_PREFIX);
}

/**
 * Path scope grammar: `path:<absolute-prefix>` where the prefix MUST start with `/`.
 * Trailing `/*` and `/` are stripped during normalization. `path:/` means root (any path).
 * Returns the normalized prefix (without `path:`) or null if malformed.
 */
export function parsePathScope(value: string): string | null {
  if (!isPathScope(value)) return null;
  let prefix = value.slice(PATH_SCOPE_PREFIX.length).trim();
  if (prefix.length === 0) return null;
  // Strip trailing /*
  if (prefix.endsWith("/*")) prefix = prefix.slice(0, -2);
  if (!prefix.startsWith("/")) return null;
  // Reject double-slash / .. / control chars / glob anywhere except trailing
  if (prefix.includes("//") || prefix.includes("/../") || prefix.endsWith("/..") || prefix.includes("*")) return null;
  if (/[\x00-\x1f]/u.test(prefix)) return null;
  // Strip trailing slash (except root)
  if (prefix.length > 1 && prefix.endsWith("/")) prefix = prefix.slice(0, -1);
  return prefix;
}

export function formatPathScope(prefix: string): string {
  return prefix === "/" ? `${PATH_SCOPE_PREFIX}/` : `${PATH_SCOPE_PREFIX}${prefix}/*`;
}

/**
 * Accept and normalize a free-form scope string into a deduped list of valid
 * scopes (capability + path). Unknown/malformed tokens are dropped silently —
 * the caller is expected to reject the request earlier if strict validation is
 * required.
 */
export function normalizeScopes(input?: string | string[] | null): string[] {
  const raw = Array.isArray(input) ? input : (input ?? "").split(/\s+/u);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of raw) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (isMcpScope(trimmed)) {
      if (!seen.has(trimmed)) { out.push(trimmed); seen.add(trimmed); }
      continue;
    }
    if (isPathScope(trimmed)) {
      const prefix = parsePathScope(trimmed);
      if (!prefix) continue;
      const canonical = formatPathScope(prefix);
      if (!seen.has(canonical)) { out.push(canonical); seen.add(canonical); }
      continue;
    }
    // unknown scope — dropped
  }
  return out;
}

export function normalizeMcpScopes(input?: string | string[] | null): McpScope[] {
  return normalizeScopes(input).filter((scope): scope is McpScope => isMcpScope(scope));
}

export function parseScopeParam(input?: string | null): string[] {
  const requested = normalizeScopes(input);
  return requested.length > 0 ? requested : [...DEFAULT_MCP_SCOPES];
}

export function serializeScopes(scopes: readonly string[]): string {
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

function normalizeCheckPath(path: string): string {
  if (!path) return "/";
  let p = path.trim();
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/gu, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

/**
 * Returns the list of granted path prefixes (no `path:` prefix, no trailing
 * `/*`). Empty list means "no path restriction".
 */
export function extractPathPrefixes(scopes: readonly string[]): string[] {
  const prefixes: string[] = [];
  for (const scope of scopes) {
    if (!isPathScope(scope)) continue;
    const prefix = parsePathScope(scope);
    if (prefix !== null) prefixes.push(prefix);
  }
  return prefixes;
}

/**
 * A path is allowed if either:
 *  - The granted scopes contain no `path:*` scope (backwards compat: capability-only token).
 *  - The path equals OR is descended from at least one granted prefix.
 *
 * Used to enforce blast-radius limits on tool calls.
 */
export function pathAllowed(grantedScopes: readonly string[], targetPath: string): boolean {
  const prefixes = extractPathPrefixes(grantedScopes);
  if (prefixes.length === 0) return true;
  const target = normalizeCheckPath(targetPath);
  for (const prefix of prefixes) {
    if (prefix === "/") return true;
    if (target === prefix) return true;
    if (target.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export function requirePathAllowed(grantedScopes: readonly string[], targetPath: string): void {
  if (!pathAllowed(grantedScopes, targetPath)) {
    throw new Error(`invalid_scope:path:${normalizeCheckPath(targetPath)}`);
  }
}

export function scopeDescriptions(scopes: readonly string[]): Array<{ scope: string; description: string }> {
  return scopes.map((scope) => {
    if (isMcpScope(scope)) return { scope, description: SCOPE_DESCRIPTIONS[scope] };
    if (isPathScope(scope)) {
      const prefix = parsePathScope(scope);
      if (prefix === null) return { scope, description: "Unknown path restriction" };
      const human = prefix === "/" ? "the entire drive" : `paths under ${prefix}/`;
      return { scope, description: `Restrict file/folder operations to ${human}` };
    }
    return { scope, description: "Unknown scope" };
  });
}

export function filterAllowedScopes(requestedScopes: readonly string[], allowedScopes: readonly string[]): string[] {
  const allowedCaps = new Set<string>(allowedScopes.filter((s) => isMcpScope(s)));
  const requestedPathsAllowed = new Set<string>(allowedScopes.filter((s) => isPathScope(s)));
  const hasAnyAllowedPath = requestedPathsAllowed.size > 0;
  return requestedScopes.filter((scope) => {
    if (isMcpScope(scope)) return allowedCaps.has(scope);
    if (isPathScope(scope)) {
      // If the allowedScopes list contains no path scope, treat path scopes as
      // freely grantable (the consenting user can attach any prefix). If it does
      // contain path scopes, only allow exact matches.
      return !hasAnyAllowedPath || requestedPathsAllowed.has(scope);
    }
    return false;
  });
}
