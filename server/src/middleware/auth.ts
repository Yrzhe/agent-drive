import type { MiddlewareHandler } from "hono";

import { parseBearerToken, timingSafeEqualStrings } from "../lib/crypto";
import { ApiError, handleApiError } from "../lib/errors";

export const requireDualAuth: MiddlewareHandler = async (c, next) => {
  try {
    const { auth } = await import("edgespark/http");
    if (auth.isAuthenticated()) {
      await next();
      return;
    }

    const token = parseBearerToken(c.req.header("authorization"));
    if (!token) throw new ApiError(401, "unauthorized", "Authentication required");

    const { secret } = await import("edgespark");
    const configured = secret.get("AGENT_TOKEN");
    if (!configured || !timingSafeEqualStrings(token, configured)) {
      throw new ApiError(401, "invalid_token", "Invalid bearer token");
    }

    await next();
  } catch (error) {
    return handleApiError(c, error);
  }
};
