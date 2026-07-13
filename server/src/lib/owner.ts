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
