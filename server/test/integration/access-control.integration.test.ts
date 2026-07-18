import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { allowlist, oauthTokens, userAccess } from "@defs";

import app from "../../src/index";
import { resolveAccessStatus } from "../../src/lib/access";
import { nowIso } from "../../src/lib/files";
import { clearSession, jsonHeaders, resetRuntime, runtime, seedOwner, useBearer, useSession } from "./edge-runtime";

describe("resolveAccessStatus", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("allowlisted → active, others → pending, owner → active", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    await runtime.db.insert(allowlist).values({ email: "vip@x.test", addedBy: "OWNER", addedAt: nowIso() } as never);

    expect(await resolveAccessStatus(runtime.db as never, { id: "u1", email: "vip@x.test" })).toBe("active");
    expect(await resolveAccessStatus(runtime.db as never, { id: "u2", email: "rando@x.test" })).toBe("pending");
    expect(await resolveAccessStatus(runtime.db as never, { id: "OWNER", email: "owner@x.test" })).toBe("active");
  });

  it("matches allowlist emails case-insensitively", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    await runtime.db.insert(allowlist).values({ email: "vip@x.test", addedBy: "OWNER", addedAt: nowIso() } as never);

    expect(await resolveAccessStatus(runtime.db as never, { id: "u3", email: "VIP@X.TEST" })).toBe("active");
  });

  it("is idempotent and never re-flips a decided status", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");

    // First call materializes the row as pending (not allowlisted).
    expect(await resolveAccessStatus(runtime.db as never, { id: "u4", email: "rando@x.test" })).toBe("pending");

    // Admin decision flips the row to suspended out-of-band.
    await runtime.db.update(userAccess).set({ status: "suspended", decidedBy: "OWNER", decidedAt: nowIso() }).where(
      eq(userAccess.userId, "u4")
    );

    // A second call must not re-materialize/re-flip it back to pending or active.
    expect(await resolveAccessStatus(runtime.db as never, { id: "u4", email: "rando@x.test" })).toBe("suspended");
  });

  it("owner short-circuits to active even without an allowlist row", async () => {
    seedOwner({ email: "Owner@X.test", id: "OWNER2" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");

    expect(await resolveAccessStatus(runtime.db as never, { id: "OWNER2", email: "Owner@X.test" })).toBe("active");
  });

  it("unset OWNER_EMAIL short-circuits everyone to active (legacy trust-any) without materializing a pending row", async () => {
    // No runtime.vars.set("OWNER_EMAIL", ...) — deliberately unset.
    expect(await resolveAccessStatus(runtime.db as never, { id: "u5", email: "whoever@x.test" })).toBe("active");

    const rows = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "u5"));
    expect(rows).toHaveLength(0);
  });

  it("returns the existing row's status without throwing when a user_access row already exists for a first-seen user", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");

    // Simulate a concurrent request that already materialized this user's row.
    await runtime.db.insert(userAccess).values({ userId: "u6", status: "active", appliedAt: nowIso() } as never);

    await expect(resolveAccessStatus(runtime.db as never, { id: "u6", email: "rando@x.test" })).resolves.toBe("active");

    const rows = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "u6"));
    expect(rows).toHaveLength(1);
  });

  it("resolves concurrent first-resolutions for the same new user without throwing, to the same status", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");

    const [statusA, statusB] = await Promise.all([
      resolveAccessStatus(runtime.db as never, { id: "u7", email: "rando2@x.test" }),
      resolveAccessStatus(runtime.db as never, { id: "u7", email: "rando2@x.test" }),
    ]);

    expect(statusA).toBe("pending");
    expect(statusB).toBe("pending");

    const rows = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "u7"));
    expect(rows).toHaveLength(1);
  });

  // Finding 2 — owner identity by uniquely-resolved id, not email compare.
  it("a case-only duplicate of OWNER_EMAIL does not self-activate over a stored suspended row", async () => {
    // Auth-user uniqueness is on the RAW email, so `owner@x.test` and `Owner@x.test`
    // coexist. resolveOwnerUserId returns null on that ambiguity, so neither can
    // short-circuit to active by an email compare — the duplicate stays suspended.
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    seedOwner({ email: "Owner@x.test", id: "DUP" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    await runtime.db.insert(userAccess).values({ userId: "DUP", status: "suspended", appliedAt: nowIso() } as never);

    expect(await resolveAccessStatus(runtime.db as never, { id: "DUP", email: "Owner@x.test" })).toBe("suspended");
  });

  it("resolves the unique owner to active by id (happy path)", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");

    expect(await resolveAccessStatus(runtime.db as never, { id: "OWNER", email: "owner@x.test" })).toBe("active");
  });
});

describe("account routes", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const res = await app.request("/api/public/v1/account/status");
    expect(res.status).toBe(401);
  });

  it("a pending user's /status returns pending, is not admin, and is not blocked by the single-owner boundary", async () => {
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    useSession({ id: "pending-1", email: "rando@x.test" });

    const res = await app.request("/api/public/v1/account/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending", email: "rando@x.test", isAdmin: false });
  });

  it("/apply stores the message and referral on the pending row and keeps status pending", async () => {
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    useSession({ id: "pending-2", email: "rando2@x.test" });

    const res = await app.request("/api/public/v1/account/apply", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "please let me in", ref: "friend-123" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending", email: "rando2@x.test", isAdmin: false });

    const [row] = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "pending-2"));
    expect(row.status).toBe("pending");
    expect(row.message).toBe("please let me in");
    expect(row.referredBy).toBe("friend-123");
  });

  it("a follow-up /apply without a message does not wipe a previously stored message", async () => {
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    useSession({ id: "pending-3", email: "rando3@x.test" });

    await app.request("/api/public/v1/account/apply", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "first message" }),
    });
    await app.request("/api/public/v1/account/apply", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });

    const [row] = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "pending-3"));
    expect(row.message).toBe("first message");
  });

  it("rejects an oversized message with 400 validation_error", async () => {
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    useSession({ id: "pending-4", email: "rando4@x.test" });

    const res = await app.request("/api/public/v1/account/apply", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "x".repeat(501) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("validation_error");
  });

  it("an allowlisted user's /status is active and /apply is a no-op", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    await runtime.db.insert(allowlist).values({ email: "vip@x.test", addedBy: "OWNER", addedAt: nowIso() } as never);
    useSession({ id: "vip-1", email: "vip@x.test" });

    const statusRes = await app.request("/api/public/v1/account/status");
    expect(await statusRes.json()).toEqual({ status: "active", email: "vip@x.test", isAdmin: false });

    const applyRes = await app.request("/api/public/v1/account/apply", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ message: "should be ignored" }),
    });
    expect(applyRes.status).toBe(200);
    expect(await applyRes.json()).toEqual({ status: "active", email: "vip@x.test", isAdmin: false });

    const [row] = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "vip-1"));
    expect(row.status).toBe("active");
    expect(row.message).toBeNull();
  });

  it("the owner's /status is active and isAdmin", async () => {
    seedOwner({ id: "OWNER", email: "owner@x.test" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    useSession({ id: "OWNER", email: "owner@x.test" });

    const res = await app.request("/api/public/v1/account/status");
    expect(await res.json()).toEqual({ status: "active", email: "owner@x.test", isAdmin: true });
  });

  // Finding 3 — /status isAdmin must mirror the fail-closed assertAdmin enforcement.
  it("reports isAdmin:false for a non-owner session (OWNER_EMAIL set)", async () => {
    seedOwner({ id: "OWNER", email: "owner@x.test" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    await runtime.db.insert(allowlist).values({ email: "vip@x.test", addedBy: "OWNER", addedAt: nowIso() } as never);
    useSession({ id: "vip-x", email: "vip@x.test" });

    const res = await app.request("/api/public/v1/account/status");
    expect((await res.json() as { isAdmin: boolean }).isAdmin).toBe(false);
  });

  it("reports isAdmin:false when OWNER_EMAIL is unset (matches fail-closed assertAdmin, not trust-any)", async () => {
    // OWNER_EMAIL unset → isRequestOwner() is trust-any true, but assertAdmin fails
    // closed, so /status must report isAdmin:false to match real enforcement.
    useSession({ id: "anyone", email: "anyone@x.test" });

    const res = await app.request("/api/public/v1/account/status");
    expect(res.status).toBe(200);
    expect((await res.json() as { isAdmin: boolean }).isAdmin).toBe(false);
  });
});

describe("access-gate middleware", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("a pending session gets 403 access_pending on /files but 200 on /account/status", async () => {
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    useSession({ id: "pending-gate-1", email: "rando@x.test" });

    const filesRes = await app.request("/api/public/v1/files?path=/");
    expect(filesRes.status).toBe(403);
    const body = (await filesRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("access_pending");

    const statusRes = await app.request("/api/public/v1/account/status");
    expect(statusRes.status).toBe(200);
  });

  it("a suspended session gets 403 access_suspended on /files", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    useSession({ id: "suspended-gate-1", email: "suspended@x.test" });
    // Materialize the row, then have the admin flip it to suspended out-of-band.
    await resolveAccessStatus(runtime.db as never, { id: "suspended-gate-1", email: "suspended@x.test" });
    await runtime.db.update(userAccess).set({ status: "suspended", decidedBy: "OWNER", decidedAt: nowIso() }).where(
      eq(userAccess.userId, "suspended-gate-1")
    );

    const filesRes = await app.request("/api/public/v1/files?path=/");
    expect(filesRes.status).toBe(403);
    const body = (await filesRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("access_suspended");
  });

  it("an active (allowlisted) session gets 200 on /files", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    await runtime.db.insert(allowlist).values({ email: "vip@x.test", addedBy: "OWNER", addedAt: nowIso() } as never);
    useSession({ id: "active-gate-1", email: "vip@x.test" });

    const res = await app.request("/api/public/v1/files?path=/");
    expect(res.status).toBe(200);
  });

  it("the owner session always gets 200 on /files", async () => {
    seedOwner({ id: "OWNER", email: "owner@x.test" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    useSession({ id: "OWNER", email: "owner@x.test" });

    const res = await app.request("/api/public/v1/files?path=/");
    expect(res.status).toBe(200);
  });

  it("a bearer token still gets 200 on /files (unaffected)", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    const headers = useBearer(["read:drive"]);

    const res = await app.request("/api/public/v1/files?path=/", { headers });
    expect(res.status).toBe(200);
  });
});

describe("bearer access is gated by principal status (#30 Part ② final review)", () => {
  const OWNER_EMAIL = "owner@x.test";

  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  // Finding 1 (CRITICAL) — the gate must confine a bearer by its principal's status.
  // Suspension is applied out-of-band here (not via the admin route) so the token stays
  // VALID: this isolates the gate's status check from the separate token-revocation fix.
  it("a suspended user's still-valid pre-minted drive token is rejected 403 access_suspended by the gate", async () => {
    seedOwner({ email: OWNER_EMAIL, id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", OWNER_EMAIL);
    await runtime.db.insert(allowlist).values({ email: "member@x.test", addedBy: "OWNER", addedAt: nowIso() } as never);

    // An active non-owner mints a drive token bound to themselves (materializes their
    // user_access row as active via the gate).
    useSession({ id: "member-1", email: "member@x.test" });
    const mintRes = await app.request("/api/public/v1/tokens", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ scopes: ["read:drive"], label: "member token" }),
    });
    expect(mintRes.status).toBe(201);
    const token = ((await mintRes.json()) as { token: string }).token;

    // The token works while the user is active (bearer path — session cleared).
    clearSession();
    const okRes = await app.request("/api/public/v1/files?path=/", { headers: { authorization: `Bearer ${token}` } });
    expect(okRes.status).toBe(200);

    // Suspend the user out-of-band — leaves the token row intact/unrevoked.
    await runtime.db
      .update(userAccess)
      .set({ status: "suspended", decidedBy: "OWNER", decidedAt: nowIso() })
      .where(eq(userAccess.userId, "member-1"));

    // The still-valid bearer no longer reaches gated content — the gate blocks it.
    clearSession();
    const blockedRes = await app.request("/api/public/v1/files?path=/", { headers: { authorization: `Bearer ${token}` } });
    expect(blockedRes.status).toBe(403);
    const body = (await blockedRes.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("access_suspended");
  });

  it("the global AGENT_TOKEN (owner-bound) still reaches gated content — no regression", async () => {
    seedOwner({ email: OWNER_EMAIL, id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", OWNER_EMAIL);
    const headers = useBearer(["read:drive"]);

    const res = await app.request("/api/public/v1/files?path=/", { headers });
    expect(res.status).toBe(200);
  });

  it("suspending a user revokes their outstanding oauth_tokens rows (defense-in-depth)", async () => {
    seedOwner({ email: OWNER_EMAIL, id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", OWNER_EMAIL);
    await runtime.db.insert(allowlist).values({ email: "member2@x.test", addedBy: "OWNER", addedAt: nowIso() } as never);

    useSession({ id: "member-2", email: "member2@x.test" });
    const mintRes = await app.request("/api/public/v1/tokens", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ scopes: ["read:drive"], label: "member token" }),
    });
    expect(mintRes.status).toBe(201);

    useSession({ id: "OWNER", email: OWNER_EMAIL });
    const suspendRes = await app.request("/api/public/v1/admin/users/member-2/suspend", { method: "POST" });
    expect(suspendRes.status).toBe(200);

    const rows = await runtime.db.select().from(oauthTokens).where(eq(oauthTokens.userId, "member-2"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.revokedAt).not.toBeNull();
  });
});

describe("drive tokens are owner-scoped (list + delete)", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("user B cannot see or revoke user A's drive token via GET / and DELETE /:id", async () => {
    seedOwner({ email: "owner@x.test", id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    await runtime.db.insert(allowlist).values({ email: "userA@x.test", addedBy: "OWNER", addedAt: nowIso() } as never);
    await runtime.db.insert(allowlist).values({ email: "userB@x.test", addedBy: "OWNER", addedAt: nowIso() } as never);

    useSession({ id: "userA", email: "userA@x.test" });
    const mintA = await app.request("/api/public/v1/tokens", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ scopes: ["read:drive"], label: "A token" }),
    });
    expect(mintA.status).toBe(201);
    const tokenAId = ((await mintA.json()) as { tokenInfo: { id: string } }).tokenInfo.id;

    useSession({ id: "userB", email: "userB@x.test" });
    const mintB = await app.request("/api/public/v1/tokens", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ scopes: ["read:drive"], label: "B token" }),
    });
    expect(mintB.status).toBe(201);
    const tokenBId = ((await mintB.json()) as { tokenInfo: { id: string } }).tokenInfo.id;

    // B's list must only contain B's own token.
    const listB = await app.request("/api/public/v1/tokens");
    const listBBody = (await listB.json()) as { tokens: { id: string }[] };
    expect(listBBody.tokens.map((t) => t.id)).toEqual([tokenBId]);

    // B cannot revoke A's token by id — 404, same as any other not-found token.
    const deleteRes = await app.request(`/api/public/v1/tokens/${tokenAId}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(404);
    const deleteBody = (await deleteRes.json()) as { error?: { code?: string } };
    expect(deleteBody.error?.code).toBe("token_not_found");

    // A's token must be provably untouched (still present, not revoked).
    useSession({ id: "userA", email: "userA@x.test" });
    const listA = await app.request("/api/public/v1/tokens");
    const listABody = (await listA.json()) as { tokens: { id: string; revokedAt: string | null }[] };
    const aToken = listABody.tokens.find((t) => t.id === tokenAId);
    expect(aToken).toBeDefined();
    expect(aToken?.revokedAt).toBeNull();
  });
});

describe("admin routes (#30 Part ② Task 4)", () => {
  const ADMIN_EMAIL = "owner@x.test";
  const ADMIN_ID = "OWNER";

  function seedAdmin(): void {
    seedOwner({ email: ADMIN_EMAIL, id: ADMIN_ID });
    runtime.vars.set("OWNER_EMAIL", ADMIN_EMAIL);
  }

  const ADMIN_ENDPOINTS: { method: string; path: string; body?: unknown }[] = [
    { method: "POST", path: "/api/public/v1/admin/backfill-owner" },
    { method: "GET", path: "/api/public/v1/admin/waitlist" },
    { method: "POST", path: "/api/public/v1/admin/waitlist/some-user/approve" },
    { method: "POST", path: "/api/public/v1/admin/waitlist/some-user/reject" },
    { method: "GET", path: "/api/public/v1/admin/allowlist" },
    { method: "POST", path: "/api/public/v1/admin/allowlist", body: { email: "x@x.test" } },
    { method: "DELETE", path: "/api/public/v1/admin/allowlist/x@x.test" },
    { method: "GET", path: "/api/public/v1/admin/users" },
    { method: "POST", path: "/api/public/v1/admin/users/some-user/suspend" },
    { method: "POST", path: "/api/public/v1/admin/users/some-user/unsuspend" },
  ];

  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("fails closed on 403 not_admin for every admin route when OWNER_EMAIL is unset — no trust-any admin", async () => {
    // Deliberately do NOT call seedAdmin() / set OWNER_EMAIL: this is the legacy
    // trust-any deployment mode. isRequestOwner() would treat this session as owner,
    // but assertAdmin must fail closed regardless — admin is the only guard on
    // these routes (access-gate exempts /admin/*), so it can never trust-any.
    useSession({ id: "not-admin", email: "not-admin@x.test" });

    for (const endpoint of ADMIN_ENDPOINTS) {
      const init: RequestInit = { method: endpoint.method };
      if (endpoint.body) {
        init.headers = jsonHeaders();
        init.body = JSON.stringify(endpoint.body);
      }
      const res = await app.request(endpoint.path, init);
      expect(res.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${endpoint.method} ${endpoint.path}`).toBe("not_admin");
    }
  });

  it("with OWNER_EMAIL set, the owner session still gets 200 and a non-owner session still gets 403 not_admin", async () => {
    seedAdmin();

    useSession({ id: "not-admin-2", email: "not-admin-2@x.test" });
    const nonOwnerRes = await app.request("/api/public/v1/admin/waitlist");
    expect(nonOwnerRes.status).toBe(403);
    const nonOwnerBody = (await nonOwnerRes.json()) as { error?: { code?: string } };
    expect(nonOwnerBody.error?.code).toBe("not_admin");

    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });
    const ownerRes = await app.request("/api/public/v1/admin/waitlist");
    expect(ownerRes.status).toBe(200);
  });

  it("rejects a non-admin session with 403 not_admin on every admin route, including backfill-owner", async () => {
    seedAdmin();
    useSession({ id: "not-admin", email: "not-admin@x.test" });

    for (const endpoint of ADMIN_ENDPOINTS) {
      const init: RequestInit = { method: endpoint.method };
      if (endpoint.body) {
        init.headers = jsonHeaders();
        init.body = JSON.stringify(endpoint.body);
      }
      const res = await app.request(endpoint.path, init);
      expect(res.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, `${endpoint.method} ${endpoint.path}`).toBe("not_admin");
    }
  });

  it("rejects a bearer token on an admin route — admin is session-only, same as backfill", async () => {
    seedAdmin();
    const headers = useBearer(["read:drive", "write:drive"]);
    const res = await app.request("/api/public/v1/admin/waitlist", { headers });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("session_required");
  });

  it("admin can list the waitlist and approve a pending user, flipping their status to active", async () => {
    seedAdmin();
    seedOwner({ id: "pend-1", email: "pend1@x.test" });
    await resolveAccessStatus(runtime.db as never, { id: "pend-1", email: "pend1@x.test" });

    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });
    const waitlistRes = await app.request("/api/public/v1/admin/waitlist");
    expect(waitlistRes.status).toBe(200);
    const waitlistBody = (await waitlistRes.json()) as { waitlist: { userId: string; email: string }[] };
    expect(waitlistBody.waitlist.map((w) => w.userId)).toContain("pend-1");

    const approveRes = await app.request("/api/public/v1/admin/waitlist/pend-1/approve", { method: "POST" });
    expect(approveRes.status).toBe(200);
    expect(await approveRes.json()).toEqual({ userId: "pend-1", status: "active" });

    const [row] = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "pend-1"));
    expect(row.status).toBe("active");
    expect(row.decidedBy).toBe(ADMIN_ID);
    expect(row.decidedAt).not.toBeNull();
  });

  it("admin can reject a pending user, flipping their status to suspended", async () => {
    seedAdmin();
    seedOwner({ id: "pend-2", email: "pend2@x.test" });
    await resolveAccessStatus(runtime.db as never, { id: "pend-2", email: "pend2@x.test" });

    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });
    const rejectRes = await app.request("/api/public/v1/admin/waitlist/pend-2/reject", { method: "POST" });
    expect(rejectRes.status).toBe(200);
    expect(await rejectRes.json()).toEqual({ userId: "pend-2", status: "suspended" });

    const [row] = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "pend-2"));
    expect(row.status).toBe("suspended");
  });

  it("returns 404 approving a userId with no user_access row", async () => {
    seedAdmin();
    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });

    const res = await app.request("/api/public/v1/admin/waitlist/ghost/approve", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("user_not_found");
  });

  it("rejects POST /allowlist with a malformed email shape (400 invalid_email)", async () => {
    seedAdmin();
    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });

    const res = await app.request("/api/public/v1/admin/allowlist", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_email");

    const listRes = await app.request("/api/public/v1/admin/allowlist");
    expect(await listRes.json()).toEqual({ allowlist: [] });
  });

  it("rejects POST /allowlist with an over-length email (>254 chars, 400 invalid_email)", async () => {
    seedAdmin();
    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });

    const overLong = `${"a".repeat(250)}@x.test`; // > 254 chars total
    const res = await app.request("/api/public/v1/admin/allowlist", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: overLong }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_email");
  });

  it("admin can add and remove an allowlist email, lowercased regardless of input casing", async () => {
    seedAdmin();
    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });

    const addRes = await app.request("/api/public/v1/admin/allowlist", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "New@X.test" }),
    });
    expect(addRes.status).toBe(201);
    expect(await addRes.json()).toEqual({ email: "new@x.test" });

    const listRes = await app.request("/api/public/v1/admin/allowlist");
    const listBody = (await listRes.json()) as { allowlist: { email: string }[] };
    expect(listBody.allowlist.map((row) => row.email)).toEqual(["new@x.test"]);

    const deleteRes = await app.request("/api/public/v1/admin/allowlist/New%40X.test", { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    const listAfter = await app.request("/api/public/v1/admin/allowlist");
    const listAfterBody = (await listAfter.json()) as { allowlist: { email: string }[] };
    expect(listAfterBody.allowlist).toEqual([]);
  });

  it("DELETE /allowlist/% (malformed percent-escape) returns 400 invalid_email, not 500", async () => {
    seedAdmin();
    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });

    const res = await app.request("/api/public/v1/admin/allowlist/%", { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_email");
  });

  it("admin GET /users lists every user with resolved status: owner active, unmaterialized pending, allowlisted active", async () => {
    seedAdmin();
    seedOwner({ id: "fresh-1", email: "fresh1@x.test" }); // never resolved — no user_access row
    seedOwner({ id: "active-1", email: "active1@x.test" });
    await runtime.db.insert(allowlist).values({ email: "active1@x.test", addedBy: ADMIN_ID, addedAt: nowIso() } as never);
    await resolveAccessStatus(runtime.db as never, { id: "active-1", email: "active1@x.test" });

    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });
    const res = await app.request("/api/public/v1/admin/users");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { userId: string; status: string }[] };
    const byId = Object.fromEntries(body.users.map((u) => [u.userId, u.status]));
    expect(byId[ADMIN_ID]).toBe("active");
    expect(byId["fresh-1"]).toBe("pending");
    expect(byId["active-1"]).toBe("active");
  });

  it("admin can suspend and unsuspend a user, flipping the access-gate result on their next request", async () => {
    seedAdmin();
    seedOwner({ id: "target-1", email: "target1@x.test" });
    await runtime.db.insert(allowlist).values({ email: "target1@x.test", addedBy: ADMIN_ID, addedAt: nowIso() } as never);
    await resolveAccessStatus(runtime.db as never, { id: "target-1", email: "target1@x.test" });

    useSession({ id: "target-1", email: "target1@x.test" });
    const beforeRes = await app.request("/api/public/v1/files?path=/");
    expect(beforeRes.status).toBe(200);

    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });
    const suspendRes = await app.request("/api/public/v1/admin/users/target-1/suspend", { method: "POST" });
    expect(suspendRes.status).toBe(200);
    expect(await suspendRes.json()).toEqual({ userId: "target-1", status: "suspended" });

    useSession({ id: "target-1", email: "target1@x.test" });
    const suspendedRes = await app.request("/api/public/v1/files?path=/");
    expect(suspendedRes.status).toBe(403);
    const suspendedBody = (await suspendedRes.json()) as { error?: { code?: string } };
    expect(suspendedBody.error?.code).toBe("access_suspended");

    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });
    const unsuspendRes = await app.request("/api/public/v1/admin/users/target-1/unsuspend", { method: "POST" });
    expect(unsuspendRes.status).toBe(200);
    expect(await unsuspendRes.json()).toEqual({ userId: "target-1", status: "active" });

    useSession({ id: "target-1", email: "target1@x.test" });
    const activeAgainRes = await app.request("/api/public/v1/files?path=/");
    expect(activeAgainRes.status).toBe(200);
  });

  it("admin cannot suspend the owner (themselves)", async () => {
    seedAdmin();
    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });

    const res = await app.request(`/api/public/v1/admin/users/${ADMIN_ID}/suspend`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("cannot_suspend_owner");

    const statusRes = await app.request("/api/public/v1/account/status");
    expect(await statusRes.json()).toMatchObject({ status: "active" });
  });

  it("admin cannot reject the owner (themselves) — same defense-in-depth guard as suspend", async () => {
    seedAdmin();
    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });

    const res = await app.request(`/api/public/v1/admin/waitlist/${ADMIN_ID}/reject`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("cannot_suspend_owner");
  });

  it("admin cannot unsuspend-write-over the owner (themselves) — same defense-in-depth guard as suspend", async () => {
    seedAdmin();
    useSession({ id: ADMIN_ID, email: ADMIN_EMAIL });

    const res = await app.request(`/api/public/v1/admin/users/${ADMIN_ID}/unsuspend`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("cannot_suspend_owner");
  });
});
