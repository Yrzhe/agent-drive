import { eq, sql } from "drizzle-orm";

import { allowlist, esSystemAuthUser, userAccess } from "@defs";

import type { AppDb } from "../types";
import { nowIso } from "./files";
import { resolveOwnerUserId } from "./owner";
import { consumeIntentForEmail } from "./registration";

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
 * When `OWNER_EMAIL` *is* set, the owner — identified by the uniquely-resolved owner
 * *id* (`resolveOwnerUserId`), never an email string compare — always short-circuits to
 * `active`. Owning by id closes a hole: auth-user uniqueness is on the RAW email, so
 * case-only duplicates (`Owner@x` / `owner@x`) can coexist; an email compare would let
 * BOTH self-activate past a stored `suspended` row. `resolveOwnerUserId` returns null on
 * that ambiguity (and when no row matches), so a duplicate never short-circuits — it
 * falls through to its authoritative `user_access` status instead.
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

  // Owner identity by uniquely-resolved id, not an email compare — see the doc comment.
  const ownerId = await resolveOwnerUserId(db);
  if (ownerId !== null && user.id === ownerId) return "active";

  const [existing] = await db
    .select({ status: userAccess.status })
    .from(userAccess)
    .where(eq(userAccess.userId, user.id))
    .limit(1);
  if (existing) return existing.status as AccessStatus;

  // Materializing a new row. A bearer principal carries no email; resolve it from the
  // auth-user table by id so an allowlisted user whose row is first seen via a bearer
  // is not spuriously stuck `pending`. This lookup only runs on first materialization
  // (rare — token holders normally already have a session-materialized row), and the
  // owner / OWNER_EMAIL-unset paths returned above never reach it.
  let userEmail = user.email?.trim();
  if (!userEmail) {
    const [authRow] = await db
      .select({ email: esSystemAuthUser.email })
      .from(esSystemAuthUser)
      .where(eq(esSystemAuthUser.id, user.id))
      .limit(1);
    userEmail = authRow?.email?.trim();
  }

  let initialStatus: AccessStatus = "pending";
  let referredBy: string | null = null;
  if (userEmail) {
    const [allowlisted] = await db
      .select({ email: allowlist.email })
      .from(allowlist)
      .where(sql`lower(${allowlist.email}) = lower(${userEmail})`)
      .limit(1);
    if (allowlisted) initialStatus = "active";

    // Part ③: an unconsumed `register/start` intent for this email donates its `ref`
    // into `referredBy` on first materialization ONLY — this annotates the waitlist for
    // the admin and never grants access or flips `status`. Uses the SAME resolved
    // `userEmail` as the allowlist check above (so the bearer-by-id resolution above
    // applies here too), and only runs once per user since this whole block is gated by
    // the "row missing" branch — an existing row is never re-stamped.
    const intent = await consumeIntentForEmail(db, userEmail);
    if (intent) referredBy = intent.ref;
  }

  await db
    .insert(userAccess)
    .values({
      userId: user.id,
      status: initialStatus,
      referredBy,
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

/**
 * Denial code + message for a resolved access status, or `null` when the principal
 * may proceed.
 *
 * Single source of truth for the principal→status gate shared by every content surface
 * (REST `middleware/access-gate.ts` and the MCP route). Callers that hold the legacy
 * global AGENT_TOKEN on an OWNER_EMAIL-unset deployment (no principal to gate) must skip
 * this and pass through — there is no id to resolve.
 */
export async function checkAccessGate(
  db: AppDb,
  principal: { id: string; email: string | null }
): Promise<{ code: "access_pending" | "access_suspended"; message: string } | null> {
  const status = await resolveAccessStatus(db, principal);
  if (status === "active") return null;
  if (status === "pending") {
    return { code: "access_pending", message: "Your account is pending admin approval." };
  }
  return { code: "access_suspended", message: "Your access has been suspended." };
}
