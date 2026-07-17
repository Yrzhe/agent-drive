import { sql } from "drizzle-orm";

import { esSystemAuthUser } from "@defs";

import type { AppDb } from "../types";
import { ApiError } from "./errors";

/**
 * Interim single-owner boundary.
 *
 * Agent Drive is a single-owner self-hosted drive: session-authenticated callers
 * are trusted with full access and content tables carry no per-owner column
 * (true multi-tenancy is a separate project). To keep that boundary from silently
 * widening if a second account ever exists, a browser session only counts as the
 * owner when its email matches the configured `OWNER_EMAIL`.
 *
 * `OWNER_EMAIL` unset → allow (single-user assumption). `disableSignUp: true`
 * blocks self-registration, but does not prove only one account row exists (an
 * imported or platform-provisioned second account is possible), so set the var to
 * actually arm the lock — see the deploy checklist. Comparison is trimmed and
 * case-insensitive.
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
 * the deployment it belongs to. `es_system__auth_user.email` is uniquely indexed, so this
 * resolves to at most one row.
 *
 * Returns `null` when `OWNER_EMAIL` is unset (legacy trust-any deployment) or no user row
 * matches. Phase 0 does not yet consume the result for authorization, so a null owner is
 * behaviour-neutral for now.
 */
export async function resolveOwnerUserId(db: AppDb): Promise<string | null> {
  const { vars } = await import("edgespark");
  const ownerEmail = vars.get("OWNER_EMAIL")?.trim();
  if (!ownerEmail) return null;
  const [row] = await db
    .select({ id: esSystemAuthUser.id })
    .from(esSystemAuthUser)
    .where(sql`lower(${esSystemAuthUser.email}) = lower(${ownerEmail})`)
    .limit(1);
  return row?.id ?? null;
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
