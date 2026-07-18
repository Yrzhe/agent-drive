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
 * The `OWNER_EMAIL` user always short-circuits to `active`; every other user gets a
 * `user_access` row on first resolution (allowlisted email → `active`, else `pending`).
 * Once materialized, the stored status is authoritative: this never re-derives or
 * re-flips a status an admin has already decided (e.g. a decided `suspended` row is
 * never bumped back to `active`/`pending` just because the email later joins the
 * allowlist, and vice versa).
 */
export async function resolveAccessStatus(
  db: AppDb,
  user: { id: string; email: string | null }
): Promise<AccessStatus> {
  const { vars } = await import("edgespark");
  const ownerEmail = vars.get("OWNER_EMAIL")?.trim();
  const userEmail = user.email?.trim();
  if (ownerEmail && userEmail && userEmail.toLowerCase() === ownerEmail.toLowerCase()) {
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

  await db.insert(userAccess).values({
    userId: user.id,
    status: initialStatus,
    appliedAt: nowIso(),
  } as never);

  return initialStatus;
}
