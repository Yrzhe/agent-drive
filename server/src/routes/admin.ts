import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { allowlist, esSystemAuthUser, userAccess } from "@defs";

import { assertAdmin } from "../lib/admin";
import { ApiError, withErrorHandling } from "../lib/errors";
import { nowIso } from "../lib/files";
import { backfillOwnerId } from "../lib/owner-backfill";
import { resolveOwnerUserId } from "../lib/owner";
import type { AppDb, AppEnv } from "../types";

export const adminRoutes = new Hono<AppEnv>();

type DecidedStatus = "active" | "suspended";

function requireParam(c: { req: { param: (name: string) => string | undefined } }, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new ApiError(400, "validation_error", `Missing path param: ${name}`);
  return value;
}

async function requireAuthenticatedAdmin(): Promise<{ id: string }> {
  const { auth } = await import("edgespark/http");
  if (!auth.isAuthenticated()) throw new ApiError(401, "unauthorized", "Authentication required");
  return { id: auth.user.id };
}

/** Stamp a `user_access` decision. 404s if the target has no row yet (never invented here). */
async function setDecidedStatus(
  db: AppDb,
  userId: string,
  status: DecidedStatus,
  decidedBy: string
): Promise<{ userId: string; status: string }> {
  const [row] = await db
    .update(userAccess)
    .set({ status, decidedBy, decidedAt: nowIso() })
    .where(eq(userAccess.userId, userId))
    .returning({ userId: userAccess.userId, status: userAccess.status });
  if (!row) throw new ApiError(404, "user_not_found", "No user_access row exists for that user");
  return row;
}

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
    await assertAdmin(c);
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

/** Pending signups: `user_access` joined to the auth-user table for display fields. */
adminRoutes.get(
  "/waitlist",
  withErrorHandling(async (c) => {
    await assertAdmin(c);
    const { db } = await import("edgespark");
    const rows = await db
      .select({
        userId: userAccess.userId,
        email: esSystemAuthUser.email,
        name: esSystemAuthUser.name,
        message: userAccess.message,
        referredBy: userAccess.referredBy,
        appliedAt: userAccess.appliedAt,
      })
      .from(userAccess)
      .innerJoin(esSystemAuthUser, eq(userAccess.userId, esSystemAuthUser.id))
      .where(eq(userAccess.status, "pending"));
    return c.json({ waitlist: rows });
  })
);

adminRoutes.post(
  "/waitlist/:userId/approve",
  withErrorHandling(async (c) => {
    await assertAdmin(c);
    const admin = await requireAuthenticatedAdmin();
    const { db } = await import("edgespark");
    const row = await setDecidedStatus(db, requireParam(c, "userId"), "active", admin.id);
    return c.json(row);
  })
);

/** Rejected applicants land in `suspended` — there is no separate `rejected` status. */
adminRoutes.post(
  "/waitlist/:userId/reject",
  withErrorHandling(async (c) => {
    await assertAdmin(c);
    const admin = await requireAuthenticatedAdmin();
    const { db } = await import("edgespark");
    const row = await setDecidedStatus(db, requireParam(c, "userId"), "suspended", admin.id);
    return c.json(row);
  })
);

adminRoutes.get(
  "/allowlist",
  withErrorHandling(async (c) => {
    await assertAdmin(c);
    const { db } = await import("edgespark");
    const rows = await db.select().from(allowlist);
    return c.json({ allowlist: rows });
  })
);

adminRoutes.post(
  "/allowlist",
  withErrorHandling(async (c) => {
    await assertAdmin(c);
    const admin = await requireAuthenticatedAdmin();
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
    if (typeof body.email !== "string" || body.email.trim().length === 0) {
      throw new ApiError(400, "validation_error", "email is required");
    }
    // Stored lowercased — resolveAccessStatus/the /apply flow both compare case-insensitively
    // via lower(), but storing lowercased too keeps GET /allowlist and DELETE /allowlist/:email
    // (an exact-match delete) consistent with what's actually on the row.
    const email = body.email.trim().toLowerCase();
    const { db } = await import("edgespark");
    await db
      .insert(allowlist)
      .values({ email, addedBy: admin.id, addedAt: nowIso() } as never)
      .onConflictDoNothing();
    return c.json({ email }, 201);
  })
);

adminRoutes.delete(
  "/allowlist/:email",
  withErrorHandling(async (c) => {
    await assertAdmin(c);
    const email = decodeURIComponent(requireParam(c, "email")).trim().toLowerCase();
    const { db } = await import("edgespark");
    await db.delete(allowlist).where(eq(allowlist.email, email));
    return c.json({ email });
  })
);

/**
 * Every user + their access status: left join so users who have never triggered
 * `resolveAccessStatus` (no `user_access` row yet) still appear.
 *
 * A missing row is displayed as `"pending"` — the status `resolveAccessStatus` would
 * materialize on that user's first gated request (their possible allowlist membership
 * isn't re-checked here; showing "pending" is the conservative default, not a guess).
 * The deployment owner is special-cased to `"active"`: the owner short-circuits inside
 * `resolveAccessStatus` and so intentionally NEVER gets a `user_access` row — without this
 * override they would incorrectly show as "pending" too.
 */
adminRoutes.get(
  "/users",
  withErrorHandling(async (c) => {
    await assertAdmin(c);
    const { db } = await import("edgespark");
    const [rows, ownerId] = await Promise.all([
      db
        .select({
          userId: esSystemAuthUser.id,
          email: esSystemAuthUser.email,
          name: esSystemAuthUser.name,
          status: userAccess.status,
        })
        .from(esSystemAuthUser)
        .leftJoin(userAccess, eq(esSystemAuthUser.id, userAccess.userId)),
      resolveOwnerUserId(db),
    ]);
    const users = rows.map((row) => ({
      ...row,
      status: row.userId === ownerId ? "active" : row.status ?? "pending",
    }));
    return c.json({ users });
  })
);

adminRoutes.post(
  "/users/:userId/suspend",
  withErrorHandling(async (c) => {
    await assertAdmin(c);
    const userId = requireParam(c, "userId");
    const admin = await requireAuthenticatedAdmin();
    const { db } = await import("edgespark");
    const ownerId = await resolveOwnerUserId(db);
    // The owner is always active; refuse suspending them (or the admin suspending
    // themselves, which — under this codebase's single-owner boundary — is the same
    // account whenever OWNER_EMAIL is configured, and worth blocking on its own even
    // when it isn't resolvable, e.g. a legacy OWNER_EMAIL-unset deployment).
    if (userId === admin.id || (ownerId !== null && userId === ownerId)) {
      throw new ApiError(400, "cannot_suspend_owner", "The deployment owner cannot be suspended");
    }
    const row = await setDecidedStatus(db, userId, "suspended", admin.id);
    return c.json(row);
  })
);

adminRoutes.post(
  "/users/:userId/unsuspend",
  withErrorHandling(async (c) => {
    await assertAdmin(c);
    const admin = await requireAuthenticatedAdmin();
    const { db } = await import("edgespark");
    const row = await setDecidedStatus(db, requireParam(c, "userId"), "active", admin.id);
    return c.json(row);
  })
);
