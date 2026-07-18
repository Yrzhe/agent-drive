import type { MiddlewareHandler } from "hono";

import { parseBearerToken } from "../lib/crypto";
import { ApiError, handleApiError } from "../lib/errors";
import { authenticateMcpBearer } from "../lib/mcp-auth";
import { hasScope } from "../lib/mcp-scopes";
import { requiredRestScope } from "../lib/rest-scopes";
import type { AppEnv } from "../types";

/**
 * Authenticates the request (session or bearer) and sets `restAuth`/`ownerId`.
 *
 * Does NOT enforce single-owner or access-status here — that was the Part ①a
 * `assertRequestOwner()` boundary, which is REPLACED (not extended) by the Part ②
 * access-gate (`requireActiveAccess`, applied after this middleware in `index.ts`).
 * A second `active` user is not the owner but must still get through auth; the gate,
 * not auth, is what confines pending/suspended sessions.
 */
export const requireDualAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    const { auth } = await import("edgespark/http");
    if (auth.isAuthenticated()) {
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
