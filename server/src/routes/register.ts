import { Hono } from "hono";

import { ApiError, withErrorHandling } from "../lib/errors";
import { checkRateLimit, recordRateLimitAttempt } from "../lib/rate-limit";
import { createRegistrationIntent, getActiveRegistrationIntent, parseRegistrationStartBody } from "../lib/registration";

// Public, unauthenticated agent-native registration handoff (#30 Part ③). A recipient's
// agent calls POST /start on the human's behalf to mint a short-lived intent, then hands
// the human a pre-filled `/signup?token=...` link. Neither endpoint ever touches a
// password, session, or email-verification state — those still flow through the normal
// signup form the link points at.
export const registerRoutes = new Hono();

const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function requestIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

function publicOrigin(c: { req: { url: string } }): Promise<string> {
  return import("edgespark").then(({ vars }) =>
    (vars.get("ALLOWED_ORIGIN") ?? new URL(c.req.url).origin).replace(/\/+$/u, "")
  );
}

registerRoutes.post(
  "/start",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const rateLimitKey = `register-start:${requestIp(c)}`;
    const limitState = await checkRateLimit(db, rateLimitKey, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS);
    if (!limitState.allowed) {
      const retryAfterMs = limitState.retryAfterMs ?? RATE_LIMIT_WINDOW_MS;
      c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      throw new ApiError(429, "too_many_attempts", `Too many registration attempts. Try again in ${Math.ceil(retryAfterMs / 60000)} minutes.`);
    }
    // Count every call toward the limit, not just failures — this endpoint materializes a
    // DB row per call, so it must not be usable as a free write amplifier.
    await recordRateLimitAttempt(db, rateLimitKey, RATE_LIMIT_WINDOW_MS);

    const body = await c.req.json().catch(() => ({}));
    const input = parseRegistrationStartBody(body);

    const { token, expiresAt } = await createRegistrationIntent(db, input);
    const origin = await publicOrigin(c);

    return c.json({ handoffUrl: `${origin}/signup?token=${token}`, expiresAt }, 201);
  })
);

registerRoutes.get(
  "/intent/:token",
  withErrorHandling(async (c) => {
    const token = c.req.param("token");
    if (!token) throw new ApiError(400, "validation_error", "Missing path param: token");

    const { db } = await import("edgespark");
    const intent = await getActiveRegistrationIntent(db, token);
    if (!intent) throw new ApiError(404, "intent_not_found", "Registration intent not found or expired");

    return c.json(intent);
  })
);
