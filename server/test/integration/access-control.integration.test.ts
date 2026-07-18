import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { allowlist, userAccess } from "@defs";

import app from "../../src/index";
import { resolveAccessStatus } from "../../src/lib/access";
import { nowIso } from "../../src/lib/files";
import { jsonHeaders, resetRuntime, runtime, seedOwner, useBearer, useSession } from "./edge-runtime";

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
    runtime.vars.set("OWNER_EMAIL", "owner@x.test");
    useSession({ id: "OWNER", email: "owner@x.test" });

    const res = await app.request("/api/public/v1/account/status");
    expect(await res.json()).toEqual({ status: "active", email: "owner@x.test", isAdmin: true });
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
