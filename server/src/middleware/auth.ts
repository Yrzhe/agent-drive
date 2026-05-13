import type { MiddlewareHandler } from "hono";

import { parseBearerToken } from "../lib/crypto";
import { ApiError, handleApiError } from "../lib/errors";
import { authenticateMcpBearer } from "../lib/mcp-auth";

export const requireDualAuth: MiddlewareHandler = async (c, next) => {
  try {
    const { auth } = await import("edgespark/http");
    if (auth.isAuthenticated()) {
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

    await next();
  } catch (error) {
    return handleApiError(c, error);
  }
};
