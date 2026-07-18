import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { userAccess } from "@defs";

import { resolveAccessStatus } from "../lib/access";
import { ApiError, withErrorHandling } from "../lib/errors";
import { resolveOwnerUserId } from "../lib/owner";
import { requireSessionAuth } from "../lib/rest-scopes";
import type { AppEnv } from "../types";

export const accountRoutes = new Hono<AppEnv>();

const MAX_MESSAGE_CHARS = 500;
const MAX_REF_CHARS = 128;

/**
 * Parse an optional string field from the `/apply` body.
 *
 * Three-way result distinguishes "field omitted" (undefined — leave the stored value
 * alone) from "field explicitly cleared" (null — a blank/whitespace-only string counts
 * as clearing it) so a follow-up `/apply` call without `message` never wipes a message
 * sent in an earlier call.
 */
function parseOptionalField(input: unknown, maxChars: number, field: string): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input !== "string") throw new ApiError(400, "validation_error", `${field} must be a string`);
  if (input.length > maxChars) {
    throw new ApiError(400, "validation_error", `${field} must be at most ${maxChars} characters`);
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function requireAuthenticatedUser(): Promise<{ id: string; email: string | null }> {
  const { auth } = await import("edgespark/http");
  if (!auth.isAuthenticated()) throw new ApiError(401, "unauthorized", "Authentication required");
  return { id: auth.user.id, email: auth.user.email };
}

accountRoutes.get(
  "/status",
  withErrorHandling(async (c) => {
    requireSessionAuth(c);
    const user = await requireAuthenticatedUser();

    const { db } = await import("edgespark");
    // isAdmin mirrors the fail-closed `assertAdmin` enforcement: derive it from the
    // uniquely-resolved owner id, never `isRequestOwner()` (trust-any true for everyone
    // when OWNER_EMAIL is unset), so the web AdminPage never renders for a caller whose
    // every admin API would 403.
    const [status, ownerId] = await Promise.all([
      resolveAccessStatus(db, user),
      resolveOwnerUserId(db),
    ]);
    const isAdmin = ownerId !== null && user.id === ownerId;

    return c.json({ status, email: user.email, isAdmin });
  })
);

accountRoutes.post(
  "/apply",
  withErrorHandling(async (c) => {
    requireSessionAuth(c);
    const user = await requireAuthenticatedUser();

    const body = (await c.req.json().catch(() => ({}))) as { message?: unknown; ref?: unknown };
    const message = parseOptionalField(body.message, MAX_MESSAGE_CHARS, "message");
    const ref = parseOptionalField(body.ref, MAX_REF_CHARS, "ref");

    const { db } = await import("edgespark");
    // Materialize the row first (idempotent) so the waitlist message always lands on
    // an existing row — never derives or flips status itself, only admin approval does.
    const status = await resolveAccessStatus(db, user);

    if (status === "pending" && (message !== undefined || ref !== undefined)) {
      const patch: Partial<typeof userAccess.$inferInsert> = {};
      if (message !== undefined) patch.message = message;
      if (ref !== undefined) patch.referredBy = ref;
      await db.update(userAccess).set(patch).where(eq(userAccess.userId, user.id));
    }

    const ownerId = await resolveOwnerUserId(db);
    const isAdmin = ownerId !== null && user.id === ownerId;
    return c.json({ status, email: user.email, isAdmin });
  })
);
