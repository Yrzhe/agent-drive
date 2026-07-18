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

    it("fails closed (null) when two rows differ only by email case — never binds arbitrarily", async () => {
      // The auth-user uniqueness is on raw email, so both of these can coexist.
      seedOwner({ email: "Owner@example.test", id: "cap" });
      seedOwner({ email: "owner@example.test", id: "low" });
      runtime.vars.set("OWNER_EMAIL", "owner@example.test");

      // A case-insensitive match hits both; picking either would be a wrong-owner risk.
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

    it("fails closed (rejects the token) when OWNER_EMAIL is set but unresolved — never falls through to trust-any", async () => {
      // OWNER_EMAIL is set but no user row matches it (misconfigured deployment).
      // Per owner.ts's fail-closed contract, this must NOT behave like the legacy
      // trust-any (unset) case — the agent token must be rejected outright.
      runtime.vars.set("OWNER_EMAIL", "ghost@x.test");
      useBearer(["read:drive"], OWNER_TOKEN);

      const ctx = await authenticateMcpBearer(runtime.db as never, `Bearer ${OWNER_TOKEN}`);
      expect(ctx).toBeNull();
    });

    it("REST: a request bearing the agent token 401s when OWNER_EMAIL is set but unresolved", async () => {
      runtime.vars.set("OWNER_EMAIL", "ghost@x.test");
      const { default: app } = await import("../../src/index");

      const res = await app.request("/api/public/v1/files?path=/", {
        headers: useBearer(["read:drive", "path:/"], OWNER_TOKEN),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("invalid_token");
    });

    it("an owner-minted (oauth) token carries the minting user's id, threaded to ownerId", async () => {
      // Mint a real scoped token as the owner session, then present it as a bearer.
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
      const minted = await app.request("/api/public/v1/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: ["read:drive"], label: "t" }),
      });
      expect(minted.status).toBe(201);
      const token = (await minted.json() as { token: string }).token;

      const ctx = await authenticateMcpBearer(runtime.db as never, `Bearer ${token}`);
      expect(ctx?.kind).toBe("oauth");
      expect(ctx?.userId).toBe("owner-123"); // the minting user, threaded to restAuth.ownerId
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
