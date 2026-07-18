import type { MiddlewareHandler } from "hono";

import { parseBearerToken } from "../lib/crypto";
import { ApiError, handleApiError } from "../lib/errors";
import { authenticateMcpBearer } from "../lib/mcp-auth";
import { hasScope } from "../lib/mcp-scopes";
import { assertRequestOwner } from "../lib/owner";
import { requiredRestScope } from "../lib/rest-scopes";
import type { AppEnv } from "../types";

// Account status/waitlist-apply must be reachable by every signed-in session — including
// `pending` and `suspended` users who are, by definition, not the owner — so the
// single-owner boundary below is deliberately not enforced for these paths. This is the
// one exemption to `assertRequestOwner()`; the forthcoming access-gate (Part ② Task 3)
// must apply the same exemption for its own pending/suspended check.
const ACCOUNT_ROUTE_PATTERN = /^\/api\/public\/v1\/account(\/|$)/u;

export const requireDualAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    const { auth } = await import("edgespark/http");
    if (auth.isAuthenticated()) {
      if (!ACCOUNT_ROUTE_PATTERN.test(c.req.path)) {
        await assertRequestOwner();
      }
      c.set("restAuth", { kind: "session", ownerId: auth.user.id });
      c.set("ownerId", auth.user.id);
      await next();
      return;
    }

    if (!parseBearerToken(c.req.header("authorization"))) {
      throw new ApiError(401, "unauthorized", "Authentication required");
    }

    const { db } = await import("edgespark");
    const authContext = await authenticateMcpBearer(db, c.req.header("authorization"));
    if (!authContext) {
      throw new ApiError(401, "invalid_token", "Invalid bearer token");
    }

    const required = requiredRestScope(c.req.method, c.req.path);
    if (!hasScope(authContext.scopes, required)) {
      throw new ApiError(403, "invalid_scope", `invalid_scope:${required}`);
    }

    c.set("restAuth", { kind: "bearer", scopes: authContext.scopes, ownerId: authContext.userId });
    c.set("ownerId", authContext.userId);
    await next();
  } catch (error) {
    return handleApiError(c, error);
  }
};
