import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { authenticateMcpBearer } from "../../src/lib/mcp-auth";
import { resolveOwnerUserId } from "../../src/lib/owner";
import { resetRuntime, runtime, seedOwner, useBearer } from "./edge-runtime";

const OWNER_TOKEN = "integration-agent-token";

describe("multi-tenancy Phase 0 — ownership resolution (#30)", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  describe("resolveOwnerUserId", () => {
    it("resolves OWNER_EMAIL to its user id", async () => {
      const id = seedOwner({ email: "owner@example.test", id: "owner-123" });
      runtime.vars.set("OWNER_EMAIL", "owner@example.test");

      expect(await resolveOwnerUserId(runtime.db as never)).toBe(id);
    });

    it("matches OWNER_EMAIL case-insensitively", async () => {
      seedOwner({ email: "Owner@Example.test", id: "owner-123" });
      runtime.vars.set("OWNER_EMAIL", "owner@example.TEST");

      expect(await resolveOwnerUserId(runtime.db as never)).toBe("owner-123");
    });

    it("returns null when OWNER_EMAIL is unset (legacy trust-any deployment)", async () => {
      seedOwner({ email: "owner@example.test", id: "owner-123" });
      // OWNER_EMAIL intentionally not set

      expect(await resolveOwnerUserId(runtime.db as never)).toBeNull();
    });

    it("returns null when no user matches OWNER_EMAIL", async () => {
      seedOwner({ email: "someone@else.test", id: "other" });
      runtime.vars.set("OWNER_EMAIL", "owner@example.test");

      expect(await resolveOwnerUserId(runtime.db as never)).toBeNull();
    });
  });

  describe("AGENT_TOKEN is bound to the deployment owner", () => {
    it("agent_token auth now carries the owner id (was null)", async () => {
      const id = seedOwner({ email: "owner@example.test", id: "owner-123" });
      runtime.vars.set("OWNER_EMAIL", "owner@example.test");
      useBearer(["read:drive"], OWNER_TOKEN);

      const ctx = await authenticateMcpBearer(runtime.db as never, `Bearer ${OWNER_TOKEN}`);
      expect(ctx?.kind).toBe("agent_token");
      expect(ctx?.userId).toBe(id);
    });

    it("leaves agent_token owner null on a legacy deployment (OWNER_EMAIL unset)", async () => {
      useBearer(["read:drive"], OWNER_TOKEN);

      const ctx = await authenticateMcpBearer(runtime.db as never, `Bearer ${OWNER_TOKEN}`);
      expect(ctx?.kind).toBe("agent_token");
      expect(ctx?.userId).toBeNull();
    });
  });

  describe("REST requests carry the resolved owner in restAuth", () => {
    it("an owner session request resolves the session user's id (does not regress access)", async () => {
      seedOwner({ email: "owner@example.test", id: "owner-123" });
      runtime.vars.set("OWNER_EMAIL", "owner@example.test");
      runtime.auth = {
        authenticated: true,
        user: {
          id: "owner-123", email: "owner@example.test", name: "Owner",
          image: null, emailVerified: true, isAnonymous: false,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      };
      const { default: app } = await import("../../src/index");

      const res = await app.request("/api/public/v1/files?path=/");
      expect(res.status).toBe(200); // behaviour unchanged
    });

    it("an owner-bound AGENT_TOKEN request still succeeds (behaviour-neutral)", async () => {
      seedOwner({ email: "owner@example.test", id: "owner-123" });
      runtime.vars.set("OWNER_EMAIL", "owner@example.test");
      const { default: app } = await import("../../src/index");

      const res = await app.request("/api/public/v1/files?path=/", {
        headers: useBearer(["read:drive", "path:/"], OWNER_TOKEN),
      });
      expect(res.status).toBe(200);
    });
  });
});
