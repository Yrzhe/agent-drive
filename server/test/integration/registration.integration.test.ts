import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { registrationIntents, userAccess } from "@defs";

import app from "../../src/index";
import { resolveAccessStatus } from "../../src/lib/access";
import { nowIso } from "../../src/lib/files";
import { consumeIntentForEmail, createRegistrationIntent } from "../../src/lib/registration";
import { jsonHeaders, resetRuntime, runtime, seedOwner } from "./edge-runtime";

const IP_HEADER = "cf-connecting-ip";

function startHeaders(ip = "203.0.113.10"): HeadersInit {
  return jsonHeaders({ [IP_HEADER]: ip });
}

describe("POST /api/public/register/start", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("creates an intent and returns a handoffUrl containing the token", async () => {
    const response = await app.request("/api/public/register/start", {
      method: "POST",
      headers: startHeaders(),
      body: JSON.stringify({ email: "Recipient@Example.com", name: "Ada", ref: "agent-42" }),
    });
    expect(response.status).toBe(201);

    const body = await response.json() as { handoffUrl: string; expiresAt: string };
    expect(body.handoffUrl).toMatch(/^https?:\/\/.+\/signup\?token=.+/);
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toMatch(/password/i);

    const token = new URL(body.handoffUrl).searchParams.get("token");
    expect(token).toBeTruthy();

    const [row] = await runtime.db.select().from(registrationIntents).where(eq(registrationIntents.token, token as string)).limit(1);
    expect(row).toBeTruthy();
    // Stored lowercased so the Task-2 consume-by-email lookup is case-insensitive.
    expect(row.email).toBe("recipient@example.com");
    expect(row.ref).toBe("agent-42");
    expect(row.consumedAt).toBeNull();
    expect(row.expiresAt).toBe(body.expiresAt);

    const ttlMs = Date.parse(row.expiresAt) - Date.parse(row.createdAt);
    expect(ttlMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000);
  });

  it("rejects an invalid email with 400", async () => {
    const response = await app.request("/api/public/register/start", {
      method: "POST",
      headers: startHeaders(),
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects a missing email with 400", async () => {
    const response = await app.request("/api/public/register/start", {
      method: "POST",
      headers: startHeaders(),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("never accepts a password field, silently ignoring it", async () => {
    const response = await app.request("/api/public/register/start", {
      method: "POST",
      headers: startHeaders(),
      body: JSON.stringify({ email: "smuggler@example.com", password: "hunter2" }),
    });
    expect(response.status).toBe(201);

    const [row] = await runtime.db.select().from(registrationIntents).where(eq(registrationIntents.email, "smuggler@example.com")).limit(1);
    expect(row).toBeTruthy();
    expect(Object.keys(row)).not.toContain("password");
  });

  it("trips the rate limit after repeated calls from one IP", async () => {
    const ip = "198.51.100.7";
    let lastStatus = 0;
    let lastResponse: Response | undefined;
    for (let i = 0; i < 11; i += 1) {
      lastResponse = await app.request("/api/public/register/start", {
        method: "POST",
        headers: startHeaders(ip),
        body: JSON.stringify({ email: `agent-${i}@example.com` }),
      });
      lastStatus = lastResponse.status;
    }
    expect(lastStatus).toBe(429);
    expect(lastResponse?.headers.get("Retry-After")).toBeTruthy();
    const body = await lastResponse?.json() as { error: { code: string } };
    expect(body.error.code).toBe("too_many_attempts");
  });

  it("does not rate-limit a different IP", async () => {
    const busyIp = "198.51.100.20";
    for (let i = 0; i < 10; i += 1) {
      const response = await app.request("/api/public/register/start", {
        method: "POST",
        headers: startHeaders(busyIp),
        body: JSON.stringify({ email: `busy-${i}@example.com` }),
      });
      expect(response.status).toBe(201);
    }
    const otherIpResponse = await app.request("/api/public/register/start", {
      method: "POST",
      headers: startHeaders("198.51.100.21"),
      body: JSON.stringify({ email: "fresh@example.com" }),
    });
    expect(otherIpResponse.status).toBe(201);
  });
});

describe("GET /api/public/register/intent/:token", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  async function startIntent(email: string, name?: string, ref?: string): Promise<string> {
    const response = await app.request("/api/public/register/start", {
      method: "POST",
      headers: startHeaders(`203.0.113.${Math.floor(Math.random() * 200) + 1}`),
      body: JSON.stringify({ email, name, ref }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { handoffUrl: string };
    return new URL(body.handoffUrl).searchParams.get("token") as string;
  }

  it("returns email, name, ref for an unexpired unconsumed intent", async () => {
    const token = await startIntent("prefill@example.com", "Grace", "agent-99");

    const response = await app.request(`/api/public/register/intent/${token}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { email: string; name: string | null; ref: string | null };
    expect(body).toEqual({ email: "prefill@example.com", name: "Grace", ref: "agent-99" });
    expect(JSON.stringify(body)).not.toMatch(/password/i);
  });

  it("does not consume the intent — repeated reads keep succeeding", async () => {
    const token = await startIntent("repeat@example.com");

    const first = await app.request(`/api/public/register/intent/${token}`);
    expect(first.status).toBe(200);
    const second = await app.request(`/api/public/register/intent/${token}`);
    expect(second.status).toBe(200);

    const [row] = await runtime.db.select().from(registrationIntents).where(eq(registrationIntents.token, token)).limit(1);
    expect(row.consumedAt).toBeNull();
  });

  it("404s for an unknown token", async () => {
    const response = await app.request("/api/public/register/intent/does-not-exist");
    expect(response.status).toBe(404);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("intent_not_found");
  });

  it("404s for an expired token", async () => {
    const expiredToken = "expired-token";
    await runtime.db.insert(registrationIntents).values({
      token: expiredToken,
      email: "stale@example.com",
      name: null,
      ref: null,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      consumedAt: null,
    } as never);

    const response = await app.request(`/api/public/register/intent/${expiredToken}`);
    expect(response.status).toBe(404);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("intent_not_found");
  });
});

describe("resolveAccessStatus donates a registration intent's ref into referredBy (#30 Part ③ Task 2)", () => {
  const OWNER_EMAIL = "owner@x.test";

  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("a pending user whose email had a register/start intent gets referredBy set from its ref on first materialization", async () => {
    seedOwner({ email: OWNER_EMAIL, id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", OWNER_EMAIL);
    await createRegistrationIntent(runtime.db as never, { email: "invitee@x.test", name: "Ada", ref: "owner-label" });

    const status = await resolveAccessStatus(runtime.db as never, { id: "invitee-1", email: "invitee@x.test" });
    expect(status).toBe("pending");

    const [row] = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "invitee-1"));
    expect(row.referredBy).toBe("owner-label");
  });

  it("a user with no matching intent gets referredBy: null", async () => {
    seedOwner({ email: OWNER_EMAIL, id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", OWNER_EMAIL);

    await resolveAccessStatus(runtime.db as never, { id: "no-intent-1", email: "no-intent@x.test" });

    const [row] = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "no-intent-1"));
    expect(row.referredBy).toBeNull();
  });

  it("marks the donated intent consumed, and a second materialization does not re-apply or change the existing row", async () => {
    seedOwner({ email: OWNER_EMAIL, id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", OWNER_EMAIL);
    const { token } = await createRegistrationIntent(runtime.db as never, { email: "onceonly@x.test", name: null, ref: "ref-once" });

    await resolveAccessStatus(runtime.db as never, { id: "once-1", email: "onceonly@x.test" });

    const [intentRow] = await runtime.db.select().from(registrationIntents).where(eq(registrationIntents.token, token));
    expect(intentRow.consumedAt).not.toBeNull();

    // Simulate an admin decision, then wipe referredBy out-of-band to prove a second
    // materialization call never re-donates into an already-existing row.
    await runtime.db.update(userAccess).set({
      status: "suspended",
      referredBy: null,
      decidedBy: "OWNER",
      decidedAt: nowIso(),
    }).where(eq(userAccess.userId, "once-1"));

    const statusAgain = await resolveAccessStatus(runtime.db as never, { id: "once-1", email: "onceonly@x.test" });
    expect(statusAgain).toBe("suspended");

    const [rowAgain] = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "once-1"));
    expect(rowAgain.referredBy).toBeNull();
  });

  it("never grants access or flips status — an intent's ref is ignored for the allowlist decision", async () => {
    seedOwner({ email: OWNER_EMAIL, id: "OWNER" });
    runtime.vars.set("OWNER_EMAIL", OWNER_EMAIL);
    await createRegistrationIntent(runtime.db as never, { email: "referred-not-allowlisted@x.test", name: null, ref: "some-ref" });

    const status = await resolveAccessStatus(runtime.db as never, {
      id: "referred-1",
      email: "referred-not-allowlisted@x.test",
    });

    expect(status).toBe("pending");
    const [row] = await runtime.db.select().from(userAccess).where(eq(userAccess.userId, "referred-1"));
    expect(row.referredBy).toBe("some-ref");
    expect(row.status).toBe("pending");
  });
});

describe("consumeIntentForEmail", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("returns null when no intent exists for the email", async () => {
    const result = await consumeIntentForEmail(runtime.db as never, "ghost@x.test");
    expect(result).toBeNull();
  });

  it("is case-insensitive on lookup (intents are stored lowercased)", async () => {
    await createRegistrationIntent(runtime.db as never, { email: "mixedcase@x.test", name: null, ref: "case-ref" });

    const result = await consumeIntentForEmail(runtime.db as never, "MixedCase@X.Test");
    expect(result).toEqual({ ref: "case-ref" });
  });

  it("returns null for an already-consumed intent and does not resurrect it", async () => {
    await createRegistrationIntent(runtime.db as never, { email: "usedup@x.test", name: null, ref: "used-ref" });

    const first = await consumeIntentForEmail(runtime.db as never, "usedup@x.test");
    expect(first).toEqual({ ref: "used-ref" });

    const second = await consumeIntentForEmail(runtime.db as never, "usedup@x.test");
    expect(second).toBeNull();
  });

  it("returns null for an expired intent", async () => {
    await runtime.db.insert(registrationIntents).values({
      token: "expired-for-consume",
      email: "expired@x.test",
      name: null,
      ref: "expired-ref",
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      consumedAt: null,
    } as never);

    const result = await consumeIntentForEmail(runtime.db as never, "expired@x.test");
    expect(result).toBeNull();
  });

  it("picks the newest unexpired, unconsumed intent when several exist for the same email", async () => {
    // Explicit, well-separated createdAt values — createRegistrationIntent's back-to-back
    // millisecond timestamps aren't reliably distinguishable, so this asserts the
    // ordering deterministically rather than depending on real-clock skew between calls.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await runtime.db.insert(registrationIntents).values({
      token: "multi-older",
      email: "multi@x.test",
      name: null,
      ref: "older-ref",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt,
      consumedAt: null,
    } as never);
    await runtime.db.insert(registrationIntents).values({
      token: "multi-newer",
      email: "multi@x.test",
      name: null,
      ref: "newer-ref",
      createdAt: new Date().toISOString(),
      expiresAt,
      consumedAt: null,
    } as never);

    const result = await consumeIntentForEmail(runtime.db as never, "multi@x.test");
    expect(result).toEqual({ ref: "newer-ref" });
  });
});
