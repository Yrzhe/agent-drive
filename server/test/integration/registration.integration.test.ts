import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { registrationIntents } from "@defs";

import app from "../../src/index";
import { jsonHeaders, resetRuntime, runtime } from "./edge-runtime";

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
