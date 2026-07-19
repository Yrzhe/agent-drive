import { and, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { esSystemAuthUser, spaceItems, spaceMembers, spaces } from "@defs";

import { ApiError, withErrorHandling } from "../lib/errors";
import { nowIso } from "../lib/files";
import { assertSpaceRole, resolveSpaceRole, userSpaceIds, type SpaceRole } from "../lib/spaces";
import type { AppDb, AppEnv } from "../types";

/**
 * Shared Spaces P1 Task 2 — space + membership CRUD REST endpoints.
 * (design: docs/implementation/2026-07-19-shared-spaces-design.md)
 *
 * Mounted under `/api/public/v1/spaces` in index.ts, inside the existing
 * `requireDualAuth` + `requireActiveAccess` chain — auth and pending/suspended gating are
 * already enforced before any handler here runs. `requiredRestScope`'s default fallback
 * (read:drive for GET, write:drive otherwise) already covers this path with no changes
 * needed there: spaces have no path-scoped semantics like files/folders.
 *
 * P1 spaces are `visibility: 'invite'` only (D3) — the public commons is P2, out of scope.
 */
export const spacesRoutes = new Hono<AppEnv>();

type SpaceRow = typeof spaces.$inferSelect;
type MemberRole = Exclude<SpaceRole, "creator">;

const MAX_NAME_CHARS = 200;
const MEMBER_ROLES: readonly MemberRole[] = ["viewer", "contributor", "editor"];

/**
 * The caller's resolved user id, set by `requireDualAuth` for both session and
 * user-bound bearer requests. Null only for the legacy deployment-wide `AGENT_TOKEN` on
 * an `OWNER_EMAIL`-unset install (no principal to bind to) — spaces require a real user
 * id (`spaces.creatorId` is NOT NULL, unlike files/folders' nullable `ownerId`), so that
 * caller is rejected here rather than silently attributed to a null owner.
 */
function requireCaller(c: Context<AppEnv>): string {
  const callerId = c.get("ownerId");
  if (!callerId) {
    throw new ApiError(
      403,
      "identity_required",
      "Spaces require an authenticated user identity (session or a user-bound bearer token)"
    );
  }
  return callerId;
}

function requireParam(c: Context<AppEnv>, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new ApiError(400, "validation_error", `Missing path param: ${name}`);
  return value;
}

function validateSpaceName(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new ApiError(400, "validation_error", "name is required");
  }
  const name = input.trim();
  if (name.length > MAX_NAME_CHARS) {
    throw new ApiError(400, "validation_error", `name must be at most ${MAX_NAME_CHARS} characters`);
  }
  return name;
}

function validateMemberRole(input: unknown): MemberRole {
  if (typeof input !== "string" || !(MEMBER_ROLES as readonly string[]).includes(input)) {
    throw new ApiError(400, "validation_error", `role must be one of: ${MEMBER_ROLES.join(", ")}`);
  }
  return input as MemberRole;
}

/**
 * Resolve an existing user's id from an email, case-insensitively. Never creates a user
 * (invite-by-email only targets existing accounts — design D2). Fails closed to the same
 * 404 on both "no match" and "ambiguous case-only-duplicate match", mirroring
 * `resolveOwnerUserId`'s ambiguity handling in lib/owner.ts — an invite must never
 * silently bind to an arbitrarily-picked duplicate row.
 */
async function resolveUserIdByEmail(db: AppDb, email: string): Promise<string> {
  const rows = await db
    .select({ id: esSystemAuthUser.id })
    .from(esSystemAuthUser)
    .where(sql`lower(${esSystemAuthUser.email}) = lower(${email})`)
    .limit(2);
  if (rows.length !== 1) throw new ApiError(404, "user_not_found", "No user with that email exists");
  return rows[0].id;
}

async function requireSpaceRow(db: AppDb, spaceId: string): Promise<SpaceRow> {
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) throw new ApiError(404, "space_not_found", "Space not found");
  return space;
}

/** memberCount includes the creator (who never has a space_members row of their own). */
async function spaceCounts(db: AppDb, spaceId: string): Promise<{ memberCount: number; itemCount: number }> {
  const [[memberRow], [itemRow]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId)),
    db.select({ n: sql<number>`count(*)` }).from(spaceItems).where(eq(spaceItems.spaceId, spaceId)),
  ]);
  return { memberCount: (memberRow?.n ?? 0) + 1, itemCount: itemRow?.n ?? 0 };
}

function toSpaceSummary(space: SpaceRow, role: SpaceRole, counts: { memberCount: number; itemCount: number }) {
  return {
    id: space.id,
    name: space.name,
    visibility: space.visibility,
    creatorId: space.creatorId,
    createdAt: space.createdAt,
    role,
    memberCount: counts.memberCount,
    itemCount: counts.itemCount,
  };
}

spacesRoutes.post(
  "/",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = validateSpaceName(body.name);

    const { db } = await import("edgespark");
    const [space] = await db
      .insert(spaces)
      .values({ id: nanoid(), name, creatorId: callerId, visibility: "invite", createdAt: nowIso() })
      .returning();
    if (!space) throw new ApiError(500, "internal_error", "Space was not created");

    return c.json({ space: toSpaceSummary(space, "creator", { memberCount: 1, itemCount: 0 }) }, 201);
  })
);

spacesRoutes.get(
  "/",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const { db } = await import("edgespark");

    const spaceIds = await userSpaceIds(db, callerId);
    if (spaceIds.length === 0) return c.json({ spaces: [] });

    const rows = await db.select().from(spaces).where(inArray(spaces.id, spaceIds));
    const result = await Promise.all(
      rows.map(async (space) => {
        // Role is never null here — `space.id` came from `userSpaceIds(callerId)`, which
        // only returns spaces the caller created or is a member of.
        const role = (await resolveSpaceRole(db, space.id, callerId)) as SpaceRole;
        const counts = await spaceCounts(db, space.id);
        return toSpaceSummary(space, role, counts);
      })
    );
    return c.json({ spaces: result });
  })
);

spacesRoutes.get(
  "/:id",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const spaceId = requireParam(c, "id");
    const { db } = await import("edgespark");

    // Not a member (or the space doesn't exist) → 404, not 403: unlike assertSpaceRole's
    // space_forbidden (used by the creator-only mutation endpoints below), a plain GET by
    // a stranger must not even confirm the space id is real.
    const role = await resolveSpaceRole(db, spaceId, callerId);
    if (role === null) throw new ApiError(404, "space_not_found", "Space not found");

    const space = await requireSpaceRow(db, spaceId);
    const counts = await spaceCounts(db, spaceId);
    return c.json({ space: toSpaceSummary(space, role, counts) });
  })
);

spacesRoutes.delete(
  "/:id",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const spaceId = requireParam(c, "id");
    const { db } = await import("edgespark");

    await assertSpaceRole(db, spaceId, callerId, "creator");

    // References only — deleting a space never touches the underlying files/memory rows,
    // only the space's own membership/item rows (design: "NOT underlying resources").
    await db.batch([
      db.delete(spaceItems).where(eq(spaceItems.spaceId, spaceId)),
      db.delete(spaceMembers).where(eq(spaceMembers.spaceId, spaceId)),
      db.delete(spaces).where(eq(spaces.id, spaceId)),
    ]);

    return c.json({ deleted: true, id: spaceId });
  })
);

spacesRoutes.get(
  "/:id/members",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const spaceId = requireParam(c, "id");
    const { db } = await import("edgespark");

    await assertSpaceRole(db, spaceId, callerId, "viewer");
    const space = await requireSpaceRow(db, spaceId);

    const memberRows = await db
      .select({
        userId: spaceMembers.userId,
        role: spaceMembers.role,
        addedBy: spaceMembers.addedBy,
        addedAt: spaceMembers.addedAt,
        email: esSystemAuthUser.email,
      })
      .from(spaceMembers)
      .leftJoin(esSystemAuthUser, eq(esSystemAuthUser.id, spaceMembers.userId))
      .where(eq(spaceMembers.spaceId, spaceId));

    const [creatorRow] = await db
      .select({ email: esSystemAuthUser.email })
      .from(esSystemAuthUser)
      .where(eq(esSystemAuthUser.id, space.creatorId))
      .limit(1);

    // The creator has no space_members row (resolveSpaceRole derives it from
    // spaces.creatorId) — synthesize it so the member list reflects everyone with access.
    const members = [
      { userId: space.creatorId, email: creatorRow?.email ?? null, role: "creator" as const, addedBy: null, addedAt: space.createdAt },
      ...memberRows,
    ];
    return c.json({ members });
  })
);

spacesRoutes.post(
  "/:id/members",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const spaceId = requireParam(c, "id");
    const { db } = await import("edgespark");

    await assertSpaceRole(db, spaceId, callerId, "creator");
    const space = await requireSpaceRow(db, spaceId);

    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; role?: unknown };
    if (typeof body.email !== "string" || body.email.trim().length === 0) {
      throw new ApiError(400, "validation_error", "email is required");
    }
    const role = validateMemberRole(body.role);
    const email = body.email.trim();
    const memberUserId = await resolveUserIdByEmail(db, email);

    if (memberUserId === space.creatorId) {
      throw new ApiError(400, "validation_error", "Cannot add the space creator as a member");
    }

    const addedAt = nowIso();
    await db
      .insert(spaceMembers)
      .values({ spaceId, userId: memberUserId, role, addedBy: callerId, addedAt })
      .onConflictDoUpdate({
        target: [spaceMembers.spaceId, spaceMembers.userId],
        set: { role, addedBy: callerId, addedAt },
      });

    return c.json({ member: { userId: memberUserId, email, role, addedBy: callerId, addedAt } }, 201);
  })
);

spacesRoutes.delete(
  "/:id/members/:userId",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const spaceId = requireParam(c, "id");
    const targetUserId = requireParam(c, "userId");
    const { db } = await import("edgespark");

    await assertSpaceRole(db, spaceId, callerId, "creator");
    const space = await requireSpaceRow(db, spaceId);

    if (targetUserId === space.creatorId) {
      throw new ApiError(400, "validation_error", "Cannot remove the space creator");
    }

    const deleted = await db
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, targetUserId)))
      .returning({ userId: spaceMembers.userId });
    if (deleted.length === 0) throw new ApiError(404, "member_not_found", "That user is not a member of this space");

    return c.json({ removed: true, userId: targetUserId });
  })
);

spacesRoutes.patch(
  "/:id/members/:userId",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const spaceId = requireParam(c, "id");
    const targetUserId = requireParam(c, "userId");
    const { db } = await import("edgespark");

    await assertSpaceRole(db, spaceId, callerId, "creator");
    const space = await requireSpaceRow(db, spaceId);

    if (targetUserId === space.creatorId) {
      throw new ApiError(400, "validation_error", "Cannot change the space creator's role");
    }

    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown };
    const role = validateMemberRole(body.role);

    const updated = await db
      .update(spaceMembers)
      .set({ role })
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, targetUserId)))
      .returning({ userId: spaceMembers.userId, role: spaceMembers.role, addedBy: spaceMembers.addedBy, addedAt: spaceMembers.addedAt });
    if (updated.length === 0) throw new ApiError(404, "member_not_found", "That user is not a member of this space");

    return c.json({ member: updated[0] });
  })
);
