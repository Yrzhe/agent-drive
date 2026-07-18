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
 * Confines SESSION requests by the caller's app-level access status
 * (`resolveAccessStatus`): `active` — including the deployment owner, who always
 * resolves to `active` — passes through; `pending`/`suspended` sessions are
 * rejected with `403 access_pending` / `403 access_suspended` on every route except
 * the exempt prefixes above.
 *
 * Bearer requests always pass through untouched: a bearer token only exists for the
 * already-active owner (agent tokens are bound to the deployment owner), so there is
 * no status to gate. Must run AFTER `requireDualAuth` — it reads `restAuth`, which
 * `requireDualAuth` sets.
 */
export const requireActiveAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    if (isExemptPath(c.req.path)) {
      await next();
      return;
    }

    const restAuth = getRestAuth(c);
    if (restAuth.kind !== "session") {
      await next();
      return;
    }

    const { auth } = await import("edgespark/http");
    if (!auth.isAuthenticated()) {
      // Unreachable in practice: requireDualAuth only sets restAuth.kind === "session"
      // for an authenticated session. Guarded for type-narrowing, fail closed.
      throw new ApiError(401, "unauthorized", "Authentication required");
    }
    const { db } = await import("edgespark");
    const status = await resolveAccessStatus(db, { id: auth.user.id, email: auth.user.email });

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
