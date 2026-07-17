import { Hono } from "hono";

import { ApiError, withErrorHandling } from "../lib/errors";
import { backfillOwnerId } from "../lib/owner-backfill";
import { resolveOwnerUserId } from "../lib/owner";
import { requireSessionAuth } from "../lib/rest-scopes";
import type { AppEnv } from "../types";

export const adminRoutes = new Hono<AppEnv>();

/**
 * Backfill `owner_id` on every content row (multi-tenancy Phase 1a).
 *
 * **Owner browser session only** — not bearer-callable. It is a one-time database-wide
 * migration operation; a scoped agent token (even the owner's) has no business triggering
 * it, and gating it to the session also keeps it correctly out of the agent-facing
 * surfaces (llms.txt / guide) — it is owner tooling, not an agent capability.
 *
 * Idempotent (safe to re-run) and fails closed if the owner cannot be resolved
 * (OWNER_EMAIL unset, no match, or a case-only-duplicate ambiguity), so it never
 * backfills to a guessed id.
 */
adminRoutes.post(
  "/backfill-owner",
  withErrorHandling(async (c) => {
    requireSessionAuth(c);
    const { db } = await import("edgespark");
    const ownerId = await resolveOwnerUserId(db);
    if (!ownerId) {
      throw new ApiError(
        409,
        "owner_unresolved",
        "Cannot backfill: the deployment owner could not be resolved. Set OWNER_EMAIL to a single existing user."
      );
    }
    const result = await backfillOwnerId(db, ownerId);
    return c.json(result);
  })
);
