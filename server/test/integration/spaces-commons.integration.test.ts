import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { spaces, userAccess } from "../../src/defs";
import app from "../../src/index";
import { nowIso } from "../../src/lib/files";
import type { AccessStatus } from "../../src/lib/access";
import {
  accessibleFileIds,
  ensurePublicCommons,
  resolveSpaceRole,
  userSpaceIds,
} from "../../src/lib/spaces";
import {
  jsonHeaders,
  resetRuntime,
  runtime,
  seedDriveFile,
  seedMemory,
  seedOwner,
  seedSpace,
  seedSpaceMember,
  useSession,
} from "./edge-runtime";

/**
 * Shared Spaces P2 Task 1 — the public commons: bootstrap, implicit membership, D4 guard.
 * (plan: docs/implementation/2026-07-20-shared-spaces-P2-PLAN.md)
 *
 * The commons is ONE instance-wide `visibility='public'` space every ACTIVE user implicitly
 * belongs to as `contributor`. Endpoints/moderation are Task 2 — these tests cover the
 * resolver layer plus the D4 folder guard on the existing contribute path.
 */
describe("public commons (P2 Task 1)", () => {
  const OWNER = { id: "owner-user", email: "owner@x.test" };
  const USER_A = { id: "user-a", email: "alice@x.test" };
  const USER_B = { id: "user-b", email: "bob@x.test" };

  /** Arm the single-owner boundary so `resolveOwnerUserId` resolves and the access gate is live. */
  function armOwner(): void {
    seedOwner({ id: OWNER.id, email: OWNER.email });
    seedOwner({ id: USER_A.id, email: USER_A.email });
    seedOwner({ id: USER_B.id, email: USER_B.email });
    runtime.vars.set("OWNER_EMAIL", OWNER.email);
  }

  /** Materialize an explicit `user_access` decision — the notion of "active" the commons uses. */
  async function setAccess(userId: string, status: AccessStatus): Promise<void> {
    await runtime.db
      .insert(userAccess)
      .values({ userId, status, appliedAt: nowIso() } as never)
      .onConflictDoUpdate({ target: userAccess.userId, set: { status } });
  }

  async function publicSpaceRows(): Promise<Array<{ id: string }>> {
    return runtime.db.select({ id: spaces.id }).from(spaces).where(eq(spaces.visibility, "public"));
  }

  async function contribute(spaceId: string, itemType: string, ref: string): Promise<Response> {
    return app.request(`/api/public/v1/spaces/${spaceId}/items`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ itemType, ref }),
    });
  }

  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  describe("ensurePublicCommons", () => {
    it("creates the commons once and only once — two calls return the same id, one public row", async () => {
      armOwner();

      const first = await ensurePublicCommons(runtime.db as never);
      const second = await ensurePublicCommons(runtime.db as never);

      expect(first).toBeTruthy();
      expect(second).toBe(first);
      expect(await publicSpaceRows()).toHaveLength(1);
    });

    it("bootstraps with the resolved owner as creator", async () => {
      armOwner();
      const commonsId = await ensurePublicCommons(runtime.db as never);

      const [row] = await runtime.db.select().from(spaces).where(eq(spaces.id, commonsId!)).limit(1);
      expect(row.creatorId).toBe(OWNER.id);
      expect(row.visibility).toBe("public");
    });

    it("returns an existing public space rather than creating a second one", async () => {
      armOwner();
      const seeded = await seedSpace({ creatorId: OWNER.id, visibility: "public", name: "Commons" });

      expect(await ensurePublicCommons(runtime.db as never)).toBe(seeded);
      expect(await publicSpaceRows()).toHaveLength(1);
    });

    it("fails closed: OWNER_EMAIL unset → null, and NOTHING is created", async () => {
      seedOwner({ id: OWNER.id, email: OWNER.email });
      // Deliberately no runtime.vars.set("OWNER_EMAIL", ...) — legacy trust-any deployment.

      expect(await ensurePublicCommons(runtime.db as never)).toBeNull();
      expect(await publicSpaceRows()).toHaveLength(0);
    });

    it("fails closed: OWNER_EMAIL set but unresolvable (no matching user) → null, nothing created", async () => {
      runtime.vars.set("OWNER_EMAIL", "nobody@x.test");

      expect(await ensurePublicCommons(runtime.db as never)).toBeNull();
      expect(await publicSpaceRows()).toHaveLength(0);
    });

    it("fails closed on ambiguity: case-only-duplicate owner emails → null, nothing created", async () => {
      seedOwner({ id: "dup-1", email: "owner@x.test" });
      seedOwner({ id: "dup-2", email: "Owner@X.test" });
      runtime.vars.set("OWNER_EMAIL", "owner@x.test");

      expect(await ensurePublicCommons(runtime.db as never)).toBeNull();
      expect(await publicSpaceRows()).toHaveLength(0);
    });
  });

  describe("resolveSpaceRole in the commons", () => {
    it("an ACTIVE non-member resolves 'contributor' in the commons but null in an unrelated invite space", async () => {
      armOwner();
      await setAccess(USER_A.id, "active");
      const commonsId = (await ensurePublicCommons(runtime.db as never))!;
      const inviteSpace = await seedSpace({ creatorId: USER_B.id });

      expect(await resolveSpaceRole(runtime.db as never, commonsId, USER_A.id)).toBe("contributor");
      expect(await resolveSpaceRole(runtime.db as never, inviteSpace, USER_A.id)).toBeNull();
    });

    it("a SUSPENDED user resolves null in the commons", async () => {
      armOwner();
      await setAccess(USER_A.id, "suspended");
      const commonsId = (await ensurePublicCommons(runtime.db as never))!;

      expect(await resolveSpaceRole(runtime.db as never, commonsId, USER_A.id)).toBeNull();
    });

    it("a PENDING user resolves null in the commons", async () => {
      armOwner();
      await setAccess(USER_A.id, "pending");
      const commonsId = (await ensurePublicCommons(runtime.db as never))!;

      expect(await resolveSpaceRole(runtime.db as never, commonsId, USER_A.id)).toBeNull();
    });

    it("the owner (commons creator) resolves 'creator' — the moderator", async () => {
      armOwner();
      const commonsId = (await ensurePublicCommons(runtime.db as never))!;

      expect(await resolveSpaceRole(runtime.db as never, commonsId, OWNER.id)).toBe("creator");
    });

    it("an explicit member row that grants MORE wins (editor); one that grants LESS does not downgrade", async () => {
      armOwner();
      await setAccess(USER_A.id, "active");
      await setAccess(USER_B.id, "active");
      const commonsId = (await ensurePublicCommons(runtime.db as never))!;

      await seedSpaceMember({ spaceId: commonsId, userId: USER_A.id, role: "editor", addedBy: OWNER.id });
      await seedSpaceMember({ spaceId: commonsId, userId: USER_B.id, role: "viewer", addedBy: OWNER.id });

      expect(await resolveSpaceRole(runtime.db as never, commonsId, USER_A.id)).toBe("editor");
      expect(await resolveSpaceRole(runtime.db as never, commonsId, USER_B.id)).toBe("contributor");
    });

    it("implicit membership never applies to an invite space, however active the caller is", async () => {
      armOwner();
      await setAccess(USER_A.id, "active");
      const inviteSpace = await seedSpace({ creatorId: USER_B.id });

      expect(await resolveSpaceRole(runtime.db as never, inviteSpace, USER_A.id)).toBeNull();
    });
  });

  describe("userSpaceIds with the commons", () => {
    it("includes the commons for an active user and excludes it for a suspended one", async () => {
      armOwner();
      await setAccess(USER_A.id, "active");
      await setAccess(USER_B.id, "suspended");
      const commonsId = (await ensurePublicCommons(runtime.db as never))!;

      expect(await userSpaceIds(runtime.db as never, USER_A.id)).toContain(commonsId);
      expect(await userSpaceIds(runtime.db as never, USER_B.id)).not.toContain(commonsId);
    });

    it("still unions the caller's own invite spaces alongside the commons", async () => {
      armOwner();
      await setAccess(USER_A.id, "active");
      const commonsId = (await ensurePublicCommons(runtime.db as never))!;
      const own = await seedSpace({ creatorId: USER_A.id });

      expect(new Set(await userSpaceIds(runtime.db as never, USER_A.id))).toEqual(new Set([commonsId, own]));
    });

    it("#30 REGRESSION GUARD: no invite spaces + an EMPTY commons still yields no accessible file ids", async () => {
      armOwner();
      await setAccess(USER_A.id, "active");
      await ensurePublicCommons(runtime.db as never);
      await seedDriveFile({ id: "b-private", path: "/b/private.txt", ownerId: USER_B.id });

      // The commons is in the union, but contributes nothing — so the read filters must
      // still collapse to the strict owner filter.
      expect(await accessibleFileIds(runtime.db as never, USER_A.id)).toEqual([]);
    });

    it("returns [] when no commons has been bootstrapped at all", async () => {
      armOwner();
      await setAccess(USER_A.id, "active");

      expect(await userSpaceIds(runtime.db as never, USER_A.id)).toEqual([]);
    });
  });

  describe("D4 guard — no folders in a public space", () => {
    it("contributing a folder to the commons → 400 folders_not_allowed_in_public", async () => {
      armOwner();
      await setAccess(USER_A.id, "active");
      const commonsId = (await ensurePublicCommons(runtime.db as never))!;
      await seedDriveFile({ id: "a-doc", path: "/proj/doc.txt", ownerId: USER_A.id });

      useSession(USER_A);
      const res = await contribute(commonsId, "folder", "/proj");
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("folders_not_allowed_in_public");
    });

    it("contributing a file or a memory to the commons succeeds", async () => {
      armOwner();
      await setAccess(USER_A.id, "active");
      const commonsId = (await ensurePublicCommons(runtime.db as never))!;
      await seedDriveFile({ id: "a-doc", path: "/proj/doc.txt", ownerId: USER_A.id });
      await seedMemory({ id: "a-mem", key: "note", content: "hello", ownerId: USER_A.id });

      useSession(USER_A);
      expect((await contribute(commonsId, "file", "/proj/doc.txt")).status).toBe(201);
      expect((await contribute(commonsId, "memory", "note")).status).toBe(201);
    });

    it("folders are still accepted by an INVITE space (D4 is public-only)", async () => {
      armOwner();
      await setAccess(USER_A.id, "active");
      await seedDriveFile({ id: "a-doc", path: "/proj/doc.txt", ownerId: USER_A.id });
      const inviteSpace = await seedSpace({ creatorId: USER_A.id });

      useSession(USER_A);
      const res = await contribute(inviteSpace, "folder", "/proj");
      expect(res.status).toBe(201);
    });
  });
});
