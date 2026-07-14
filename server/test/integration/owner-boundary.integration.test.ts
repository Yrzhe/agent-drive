import { afterAll, beforeEach, describe, expect, it } from "vitest";

import app from "../../src/index";
import { resetRuntime, runtime, useSession } from "./edge-runtime";

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await response.json() as { error?: { code?: string } };
  return body.error?.code;
}

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

  it("rejects a non-owner session with 403 not_owner", async () => {
    runtime.vars.set("OWNER_EMAIL", "owner@example.test");
    useSession({ email: "intruder@example.test" });

    const response = await app.request("/api/public/v1/files?path=/");
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("not_owner");
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

  it("blocks a non-owner from minting drive tokens", async () => {
    runtime.vars.set("OWNER_EMAIL", "owner@example.test");
    useSession({ email: "intruder@example.test" });

    const response = await app.request("/api/public/v1/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["read:drive"], expiresInDays: 1 }),
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("not_owner");
  });
});
