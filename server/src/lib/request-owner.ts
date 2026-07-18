import { tryGetContext } from "hono/context-storage";

import type { AppEnv } from "../types";

/**
 * The owner id to stamp on rows created during the current request.
 *
 * Multi-tenancy Phase 2 (owner-on-insert): every content INSERT stamps this so new rows
 * are attributed to their creator, without threading an owner argument through the ~50 call
 * sites of the shared insert helpers (`logEvent`, `ensureFolderChain`, `rememberMemory`).
 * The value is set once per request into the Hono context (see `contextStorage()` in
 * `index.ts`):
 *   - REST  (`requireDualAuth`): session `auth.user.id` / bearer `authContext.userId`
 *   - MCP   (`routes/mcp.ts`):   the bearer token's `userId`
 *   - Inbox (`routes/inbox.ts`): the receiving contact's `ownerId`
 *
 * Returns `null` when there is no request context (a helper called directly in a unit test)
 * or the owner is unresolved (legacy deploy) — matching the nullable `owner_id` policy:
 * new rows keep NULL and are swept by a later backfill before owner-filtering turns on.
 */
export function currentOwnerId(): string | null {
  return tryGetContext<AppEnv>()?.var.ownerId ?? null;
}
