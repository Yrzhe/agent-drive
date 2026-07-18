import type { Context } from "hono";

import { ApiError } from "./errors";
import { resolveOwnerUserId } from "./owner";
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
 * session-only also keeps admin out of the agent-facing surfaces). Unlike the single-owner
 * boundary (`isRequestOwner`, which trusts any session when `OWNER_EMAIL` is unset — a
 * reasonable default for drive access on a single-user deployment), admin capability MUST
 * fail closed: `resolveOwnerUserId` is used instead, and the caller's id must exactly match
 * the resolved owner id. `OWNER_EMAIL` unset, no matching row, or an ambiguous case-only
 * duplicate all resolve to `null` here, which denies every caller — a signup-enabled deploy
 * that hasn't set `OWNER_EMAIL` yet must never grant admin to an arbitrary logged-in user.
 */
export async function assertAdmin(c: Context<AppEnv>): Promise<void> {
  requireSessionAuth(c);
  const { db } = await import("edgespark");
  const { auth } = await import("edgespark/http");
  const ownerId = await resolveOwnerUserId(db);
  // `requireSessionAuth` guarantees `restAuth.kind === "session"`, which middleware only
  // ever sets after observing `auth.isAuthenticated()` true for this same request — so
  // `auth.isAuthenticated()` is redundant at runtime here. It is still called explicitly
  // (rather than asserting `auth.user` directly) purely so TypeScript's `this is
  // AuthenticatedAuthClient` guard narrows `auth.user` to non-null before it is read.
  if (!ownerId || !auth.isAuthenticated() || auth.user.id !== ownerId) {
    throw new ApiError(403, "not_admin", "Admin access required");
  }
}
