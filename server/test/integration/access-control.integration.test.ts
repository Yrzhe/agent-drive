import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { allowlist, userAccess } from "@defs";

import { resolveAccessStatus } from "../../src/lib/access";
import { nowIso } from "../../src/lib/files";
import { resetRuntime, runtime, seedOwner } from "./edge-runtime";

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
});
