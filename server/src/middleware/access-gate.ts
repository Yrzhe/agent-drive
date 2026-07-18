import type { MiddlewareHandler } from "hono";

import { resolveAccessStatus } from "../lib/access";
import { ApiError, handleApiError } from "../lib/errors";
import { getRestAuth } from "../lib/rest-scopes";
import type { AppEnv } from "../types";

/**
 * Path prefixes exempt from the status gate.
 *
 * - `/account`: pending/suspended sessions must still reach `GET /status` and
 *   `POST /apply` — that is how they see their own status and join the waitlist.
 *   Gating this path would make it impossible for a pending user to ever check in.
 * - `/admin`: owner-only tooling. `assertAdmin` (admin routes, Part ② Task 4)
 *   enforces the actual owner check there; exempting it here is a safety measure
 *   (never let this gate's status check accidentally block the owner from admin
 *   tooling due to a stale/racy `user_access` row) — not a substitute for the
 *   route-level owner check.
 */
const EXEMPT_PATH_PATTERNS = [
  /^\/api\/public\/v1\/account(\/|$)/u,
  /^\/api\/public\/v1\/admin(\/|$)/u,
];

function isExemptPath(path: string): boolean {
  return EXEMPT_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Access-gate middleware (Part ② multi-user).
 *
 * Confines BOTH session and bearer requests by the caller's app-level access status
 * (`resolveAccessStatus`): `active` — including the deployment owner, who always
 * resolves to `active` by id — passes through; `pending`/`suspended` principals are
 * rejected with `403 access_pending` / `403 access_suspended` on every route except
 * the exempt prefixes above.
 *
 * Bearers are gated too, not just sessions. A user-bound token (drive/OAuth) is minted
 * against `auth.user.id` with no owner check, so an active non-owner can mint one bound
 * to themselves; without a bearer status check that token would retain full access after
 * the admin suspends them (the suspension writes a `suspended` `user_access` row, which
 * this gate now consults for the token's principal). The one bearer that still passes
 * without a status lookup is the legacy global AGENT_TOKEN on an OWNER_EMAIL-unset
 * deployment (`restAuth.ownerId === null`, trust-any) — there is no principal to gate.
 * The owner-bound AGENT_TOKEN resolves `active` by owner id like any owner request.
 *
 * Must run AFTER `requireDualAuth` — it reads `restAuth`, which `requireDualAuth` sets.
 */
export const requireActiveAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    if (isExemptPath(c.req.path)) {
      await next();
      return;
    }

    const restAuth = getRestAuth(c);

    let principal: { id: string; email: string | null };
    if (restAuth.kind === "session") {
      const { auth } = await import("edgespark/http");
      if (!auth.isAuthenticated()) {
        // Unreachable in practice: requireDualAuth only sets restAuth.kind === "session"
        // for an authenticated session. Guarded for type-narrowing, fail closed.
        throw new ApiError(401, "unauthorized", "Authentication required");
      }
      principal = { id: auth.user.id, email: auth.user.email };
    } else {
      // Bearer. A null ownerId is the legacy global AGENT_TOKEN on an OWNER_EMAIL-unset
      // deployment (trust-any) — no principal to gate, so pass through. Never call the
      // resolver with a null id.
      if (restAuth.ownerId === null) {
        await next();
        return;
      }
      principal = { id: restAuth.ownerId, email: null };
    }

    const { db } = await import("edgespark");
    const status = await resolveAccessStatus(db, principal);

    if (status === "active") {
      await next();
      return;
    }

    if (status === "pending") {
      throw new ApiError(403, "access_pending", "Your account is pending admin approval.");
    }

    throw new ApiError(403, "access_suspended", "Your access has been suspended.");
  } catch (error) {
    return handleApiError(c, error);
  }
};
