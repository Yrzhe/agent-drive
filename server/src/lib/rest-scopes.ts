import type { Context } from "hono";

import { ApiError } from "./errors";
import { extractPathPrefixes, pathAllowed, type McpScope } from "./mcp-scopes";
import type { AppEnv, RestAuth } from "../types";

const SHARE_ROUTE_PATTERN = /^\/api\/public\/v1\/shares(\/|$)/u;
const MEMORY_ROUTE_PATTERN = /^\/api\/public\/v1\/memory(\/|$)/u;

/**
 * Capability scope required for a REST v1 request, derived from method + path.
 * Reads are `read:drive` (`read:memory` under /memory), share mutations are
 * `share:create`, every other mutation is `write:drive` (`write:memory` under
 * /memory). Enforced centrally in `requireDualAuth`.
 */
export function requiredRestScope(method: string, path: string): McpScope {
  const normalizedMethod = method.toUpperCase();
  const isRead = normalizedMethod === "GET" || normalizedMethod === "HEAD";
  if (MEMORY_ROUTE_PATTERN.test(path)) return isRead ? "read:memory" : "write:memory";
  if (isRead) return "read:drive";
  if (SHARE_ROUTE_PATTERN.test(path)) return "share:create";
  return "write:drive";
}

export function getRestAuth(c: Context<AppEnv>): RestAuth {
  const auth = c.get("restAuth");
  if (!auth) {
    // Route was mounted without requireDualAuth — fail closed instead of
    // silently skipping scope checks.
    throw new ApiError(500, "internal_error", "REST auth context missing");
  }
  return auth;
}

function invalidPathScope(path: string): ApiError {
  return new ApiError(403, "invalid_scope", `invalid_scope:path:${path}`);
}

/** Reject the request if the bearer token's path scopes do not cover `path`. */
export function assertRestPathAllowed(c: Context<AppEnv>, path: string): void {
  const auth = getRestAuth(c);
  if (auth.kind === "session") return;
  if (!pathAllowed(auth.scopes, path)) throw invalidPathScope(path);
}

/**
 * Listing variant: also allows `path` when it is an ancestor of a granted
 * prefix (mirrors MCP `list_files`) — rows must then be filtered with
 * `restPathFilter`.
 */
export function assertRestListPathAllowed(c: Context<AppEnv>, path: string): void {
  const auth = getRestAuth(c);
  if (auth.kind === "session") return;
  if (pathAllowed(auth.scopes, path)) return;
  const grantedPrefixes = extractPathPrefixes(auth.scopes);
  const allowAsAncestor = grantedPrefixes.some((prefix) => prefix.startsWith(`${path === "/" ? "" : path}/`));
  if (!allowAsAncestor) throw invalidPathScope(path);
}

/** Row filter for list endpoints; always-true for session auth. */
export function restPathFilter(c: Context<AppEnv>): (path: string) => boolean {
  const auth = getRestAuth(c);
  if (auth.kind === "session") return () => true;
  const scopes = auth.scopes;
  if (extractPathPrefixes(scopes).length === 0) return () => true;
  return (path: string) => pathAllowed(scopes, path);
}
