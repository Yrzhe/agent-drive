import type { Context } from "hono";

import { ApiError } from "./errors";
import { isRequestOwner } from "./owner";
import { requireSessionAuth } from "./rest-scopes";
import type { AppEnv } from "../types";

/**
 * Guard every `/api/public/v1/admin/*` route. Admin = the configured `OWNER_EMAIL` user only.
 *
 * The access-gate middleware exempts `/admin/*` from its pending/suspended check (see
 * `middleware/access-gate.ts`) so the owner is never accidentally locked out of admin
 * tooling by a stale `user_access` row — which means admin routes carry NO other caller
 * restriction upstream. This function is therefore the ONLY thing standing between an
 * arbitrary active session and admin capability once signup opens; it MUST be the first
 * line of every handler in `routes/admin.ts`, with no exceptions (including the
 * pre-existing `/backfill-owner`).
 *
 * `requireSessionAuth` rejects bearer callers first (admin is browser-session-only, same
 * reasoning as backfill: a scoped agent token has no business here and keeping this
 * session-only also keeps admin out of the agent-facing surfaces). `isRequestOwner` then
 * enforces the single-owner boundary (`OWNER_EMAIL` match, or trust-any when unset).
 */
export async function assertAdmin(c: Context<AppEnv>): Promise<void> {
  requireSessionAuth(c);
  if (!(await isRequestOwner())) {
    throw new ApiError(403, "not_admin", "Admin access required");
  }
}
