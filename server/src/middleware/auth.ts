import type { MiddlewareHandler } from "hono";

import { parseBearerToken } from "../lib/crypto";
import { ApiError, handleApiError } from "../lib/errors";
import { authenticateMcpBearer } from "../lib/mcp-auth";
import { hasScope } from "../lib/mcp-scopes";
import { assertRequestOwner } from "../lib/owner";
import { requiredRestScope } from "../lib/rest-scopes";
import type { AppEnv } from "../types";

export const requireDualAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    const { auth } = await import("edgespark/http");
    if (auth.isAuthenticated()) {
      await assertRequestOwner();
      c.set("restAuth", { kind: "session" });
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

    c.set("restAuth", { kind: "bearer", scopes: authContext.scopes });
    await next();
  } catch (error) {
    return handleApiError(c, error);
  }
};
