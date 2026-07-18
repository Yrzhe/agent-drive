import { afterAll, beforeEach, describe, expect, it } from "vitest";

import app from "../../src/index";
import { resetRuntime, runtime, useSession } from "./edge-runtime";

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await response.json() as { error?: { code?: string } };
  return body.error?.code;
}

/**
 * Part ①a's single-owner lock (`assertRequestOwner()` in `requireDualAuth`) was
 * REPLACED by Part ②'s access-gate (`requireActiveAccess`, Task 3, #30): a
 * non-owner session is no longer flatly rejected as `not_owner` — it is confined by
 * its app-level access status instead. A non-owner, non-allowlisted session now
 * resolves to `pending` (not `active`, since it's not the OWNER_EMAIL user and isn't
 * allowlisted) and is blocked with `403 access_pending`, not `403 not_owner`. The
 * owner-always-active and OWNER_EMAIL-unset-trust-any behaviors are unchanged, so
 * those cases below are untouched.
 */
describe("single-owner boundary", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("allows the configured owner session", async () => {
    runtime.vars.set("OWNER_EMAIL", "owner@example.test");
    useSession({ email: "owner@example.test" });

    const response = await app.request("/api/public/v1/files?path=/");
    expect(response.status).toBe(200);
  });

  it("confines a non-owner, non-allowlisted session to 403 access_pending (was: 403 not_owner)", async () => {
    runtime.vars.set("OWNER_EMAIL", "owner@example.test");
    useSession({ email: "intruder@example.test" });

    const response = await app.request("/api/public/v1/files?path=/");
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("access_pending");
  });

  it("matches the owner email case-insensitively", async () => {
    runtime.vars.set("OWNER_EMAIL", "Owner@Example.test");
    useSession({ email: "owner@example.TEST" });

    const response = await app.request("/api/public/v1/files?path=/");
    expect(response.status).toBe(200);
  });

  it("allows any session when OWNER_EMAIL is unset (single-user back-compat)", async () => {
    useSession({ email: "whoever@example.test" });

    const response = await app.request("/api/public/v1/files?path=/");
    expect(response.status).toBe(200);
  });

  it("blocks a non-owner, non-allowlisted (pending) session from minting drive tokens with 403 access_pending (was: 403 not_owner)", async () => {
    runtime.vars.set("OWNER_EMAIL", "owner@example.test");
    useSession({ email: "intruder@example.test" });

    const response = await app.request("/api/public/v1/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["read:drive"], expiresInDays: 1 }),
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("access_pending");
  });
});
