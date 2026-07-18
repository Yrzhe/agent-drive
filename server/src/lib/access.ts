import { eq, sql } from "drizzle-orm";

import { allowlist, userAccess } from "@defs";

import type { AppDb } from "../types";
import { nowIso } from "./files";

/**
 * App-level access state for a signed-up user.
 *
 * - `pending`: signed up, not yet allowlisted; sees the waitlist screen.
 * - `active`: allowed to use the drive.
 * - `suspended`: access revoked by the admin.
 */
export type AccessStatus = "active" | "pending" | "suspended";

/**
 * Resolve — and materialize if absent — a user's access status.
 *
 * `OWNER_EMAIL` unset is this codebase's established legacy trust-any convention
 * (see `owner.ts`'s `isRequestOwner`/`resolveOwnerUserId`): a deployment that never
 * configured `OWNER_EMAIL` has no gate armed at all, so every user short-circuits to
 * `active` immediately — no allowlist check, no `user_access` row materialized. This
 * keeps a legacy single-owner deployment working unchanged once a request-time gate
 * starts consuming this resolver.
 *
 * When `OWNER_EMAIL` *is* set, the matching user always short-circuits to `active`.
 * Every other user gets a `user_access` row on first resolution (allowlisted email →
 * `active`, else `pending`). Once materialized, the stored status is authoritative:
 * this never re-derives or re-flips a status an admin has already decided (e.g. a
 * decided `suspended` row is never bumped back to `active`/`pending` just because the
 * email later joins the allowlist, and vice versa).
 *
 * Race-safe by construction: two near-simultaneous first-resolutions for the same new
 * user may both reach the "row missing" branch. The insert below uses
 * `onConflictDoNothing()` so the loser silently no-ops instead of throwing on the
 * `userId` primary key, and the status returned always comes from a re-select — never
 * assumed from the (possibly lost) insert — so both callers agree on the one row that
 * actually landed.
 */
export async function resolveAccessStatus(
  db: AppDb,
  user: { id: string; email: string | null }
): Promise<AccessStatus> {
  const { vars } = await import("edgespark");
  const ownerEmail = vars.get("OWNER_EMAIL")?.trim();
  if (!ownerEmail) return "active"; // legacy trust-any: no gate armed at all.

  const userEmail = user.email?.trim();
  if (userEmail && userEmail.toLowerCase() === ownerEmail.toLowerCase()) {
    return "active";
  }

  const [existing] = await db
    .select({ status: userAccess.status })
    .from(userAccess)
    .where(eq(userAccess.userId, user.id))
    .limit(1);
  if (existing) return existing.status as AccessStatus;

  let initialStatus: AccessStatus = "pending";
  if (userEmail) {
    const [allowlisted] = await db
      .select({ email: allowlist.email })
      .from(allowlist)
      .where(sql`lower(${allowlist.email}) = lower(${userEmail})`)
      .limit(1);
    if (allowlisted) initialStatus = "active";
  }

  await db
    .insert(userAccess)
    .values({
      userId: user.id,
      status: initialStatus,
      appliedAt: nowIso(),
    } as never)
    .onConflictDoNothing();

  const [row] = await db
    .select({ status: userAccess.status })
    .from(userAccess)
    .where(eq(userAccess.userId, user.id))
    .limit(1);
  return (row?.status as AccessStatus | undefined) ?? initialStatus;
}
