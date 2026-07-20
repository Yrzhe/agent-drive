import { sql } from "drizzle-orm";

import { esSystemAuthUser } from "@defs";

import type { AppDb } from "../types";
import { ApiError } from "./errors";

/**
 * Interim single-owner boundary.
 *
 * Multi-tenancy (#30) has since shipped: content tables DO carry `owner_id` and reads
 * are owner-scoped, so this helper is no longer the only thing standing between two
 * accounts. It remains the answer to "is this session the DEPLOYMENT owner?" — the
 * question that gates owner-only tooling (admin routes, backfill) and binds the
 * install-wide `AGENT_TOKEN` to a real user id.
 *
 * `OWNER_EMAIL` unset → allow (legacy trust-any). Signup is now OPEN, so an unset
 * var means any account that can log in is treated as the owner — set it. Comparison
 * is trimmed and case-insensitive.
 */
export async function isRequestOwner(): Promise<boolean> {
  const { auth } = await import("edgespark/http");
  if (!auth.isAuthenticated()) return false;

  const { vars } = await import("edgespark");
  const ownerEmail = vars.get("OWNER_EMAIL")?.trim();
  if (!ownerEmail) return true;

  const userEmail = auth.user.email?.trim();
  return Boolean(userEmail) && userEmail!.toLowerCase() === ownerEmail.toLowerCase();
}

/**
 * Resolve the deployment owner's user id from `OWNER_EMAIL`.
 *
 * Multi-tenancy Phase 0: every accepted request needs a non-null owner, but the global
 * `AGENT_TOKEN` bearer carries no identity of its own — it is bound here to the owner of
 * the deployment it belongs to.
 *
 * Returns `null` in three cases: `OWNER_EMAIL` unset (legacy trust-any deployment), no
 * matching row (misconfigured), or an ambiguous case-only-duplicate match (see below).
 * Phase 0 does not consume the result, so null is behaviour-neutral now.
 *
 * **Null policy for later phases (decide before Phase 2 consumes this):** a request whose
 * owner cannot be resolved must be treated as follows — `OWNER_EMAIL` *unset* keeps the
 * legacy trust-any behaviour; but `OWNER_EMAIL` *set yet unresolved* (no row / ambiguous)
 * must **fail closed** (deny), never fall through to seeing the whole drive. Encoding that
 * as fail-open in Phase 2 would silently expose a drive whose owner believed isolation was
 * armed.
 *
 * **Fails closed on ambiguity.** The auth-user table's uniqueness is on the *raw* email,
 * so case-only duplicates (`Owner@x` and `owner@x`) can both exist; a case-insensitive
 * match would then hit both and an unordered `limit(1)` would bind the token to an
 * arbitrary one. Rather than pick, we return `null` when more than one row matches — the
 * foundation every later phase builds on must never silently choose the wrong owner.
 */
export async function resolveOwnerUserId(db: AppDb): Promise<string | null> {
  const { vars } = await import("edgespark");
  const ownerEmail = vars.get("OWNER_EMAIL")?.trim();
  if (!ownerEmail) return null;
  const rows = await db
    .select({ id: esSystemAuthUser.id })
    .from(esSystemAuthUser)
    .where(sql`lower(${esSystemAuthUser.email}) = lower(${ownerEmail})`)
    .limit(2);
  if (rows.length !== 1) return null; // 0 = no match, >1 = case-only-duplicate ambiguity
  return rows[0].id;
}

/** Throw 403 when the current session is authenticated but is not the owner. */
export async function assertRequestOwner(): Promise<void> {
  if (!(await isRequestOwner())) {
    throw new ApiError(
      403,
      "not_owner",
      "This drive is single-owner; your account is not the configured owner."
    );
  }
}
