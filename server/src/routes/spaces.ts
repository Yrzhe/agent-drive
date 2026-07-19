import { and, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { esSystemAuthUser, spaceItems, spaceMembers, spaces } from "@defs";

import { ApiError, withErrorHandling } from "../lib/errors";
import { nowIso } from "../lib/files";
import { parseListPagination } from "../lib/pagination";
import {
  assertSpaceRole,
  resolveOwnedContributionRef,
  resolveSpaceRole,
  resolveUserIdByEmail,
  spaceCounts,
  toDisplayItems,
  toSpaceSummary,
  userSpaceIds,
  type SpaceItemRow,
  type SpaceItemType,
  type SpaceRole,
} from "../lib/spaces";
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
const ITEM_TYPES: readonly SpaceItemType[] = ["file", "folder", "memory"];

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

function validateItemType(input: unknown): SpaceItemType {
  if (typeof input !== "string" || !(ITEM_TYPES as readonly string[]).includes(input)) {
    throw new ApiError(400, "validation_error", `itemType must be one of: ${ITEM_TYPES.join(", ")}`);
  }
  return input as SpaceItemType;
}

function validateItemRef(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new ApiError(400, "validation_error", "ref is required");
  }
  return input.trim();
}

async function requireSpaceRow(db: AppDb, spaceId: string): Promise<SpaceRow> {
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) throw new ApiError(404, "space_not_found", "Space not found");
  return space;
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

    // Retract the removed member's contributions too. Otherwise their files/memory would
    // stay readable by the remaining members once the read-path union (Task 4/5) lands,
    // while they — no longer a member — could no longer remove those items themselves. A
    // removed member's shared resources should stop being shared. Reference rows only; the
    // underlying files/memory are never touched.
    await db
      .delete(spaceItems)
      .where(and(eq(spaceItems.spaceId, spaceId), eq(spaceItems.contributedBy, targetUserId)));

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

/**
 * Shared Spaces P1 Task 3 — `space_items` contribute/remove/list.
 * (brief: .superpowers/sdd/task-3-brief.md)
 *
 * NO read-path changes here: this only manages the reference rows in `space_items` and
 * lists them flat + attributed. The read-path union (files/memory list/recall seeing
 * space-contributed resources) is Task 4/5.
 */

spacesRoutes.post(
  "/:id/items",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const spaceId = requireParam(c, "id");
    const { db } = await import("edgespark");

    // contributor+ required to add anything; a non-member/viewer never reaches the
    // ownership check below.
    await assertSpaceRole(db, spaceId, callerId, "contributor");

    const body = (await c.req.json().catch(() => ({}))) as { itemType?: unknown; ref?: unknown };
    const itemType = validateItemType(body.itemType);
    const ref = validateItemRef(body.ref);

    // Security spine (design §Security #2): only the resource's owner may contribute it.
    // Throws ApiError(403, 'not_your_resource') if `ref` isn't a live resource callerId owns.
    const itemRef = await resolveOwnedContributionRef(db, itemType, ref, callerId);

    await db
      .insert(spaceItems)
      .values({ id: nanoid(), spaceId, itemType, itemRef, contributedBy: callerId, addedAt: nowIso() })
      .onConflictDoNothing({ target: [spaceItems.spaceId, spaceItems.itemType, spaceItems.itemRef] });

    // Idempotent contribute (unique spaceId+itemType+itemRef): re-select rather than trust
    // .returning() after onConflictDoNothing, which yields [] on the no-op branch.
    const [item] = await db
      .select()
      .from(spaceItems)
      .where(and(eq(spaceItems.spaceId, spaceId), eq(spaceItems.itemType, itemType), eq(spaceItems.itemRef, itemRef)))
      .limit(1);
    if (!item) throw new ApiError(500, "internal_error", "Space item was not created");

    const [display] = await toDisplayItems(db, [item]);
    return c.json({ item: display }, 201);
  })
);

spacesRoutes.get(
  "/:id/items",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const spaceId = requireParam(c, "id");
    const { db } = await import("edgespark");

    await assertSpaceRole(db, spaceId, callerId, "viewer");

    const typeQuery = c.req.query("type");
    const itemType = typeQuery ? validateItemType(typeQuery) : undefined;
    const { limit, offset } = parseListPagination((name) => c.req.query(name), { defaultLimit: 50, maxLimit: 200 });

    const rows: SpaceItemRow[] = await db
      .select()
      .from(spaceItems)
      .where(and(eq(spaceItems.spaceId, spaceId), itemType ? eq(spaceItems.itemType, itemType) : undefined))
      .orderBy(desc(spaceItems.addedAt))
      .limit(limit)
      .offset(offset);

    // Flat, attributed list (design: "NOT merged into a path tree" — avoids cross-
    // contributor path collisions). A folder item is one entry; drill-in is Task 4.
    const items = await toDisplayItems(db, rows);
    return c.json({ items, limit, offset });
  })
);

spacesRoutes.delete(
  "/:id/items/:itemId",
  withErrorHandling(async (c) => {
    const callerId = requireCaller(c);
    const spaceId = requireParam(c, "id");
    const itemId = requireParam(c, "itemId");
    const { db } = await import("edgespark");

    // contributor+ required to remove anything; a viewer/non-member is rejected here
    // before the item lookup even runs.
    await assertSpaceRole(db, spaceId, callerId, "contributor");

    const [item] = await db
      .select()
      .from(spaceItems)
      .where(and(eq(spaceItems.id, itemId), eq(spaceItems.spaceId, spaceId)))
      .limit(1);
    if (!item) throw new ApiError(404, "item_not_found", "Space item not found");

    // A contributor may remove only their OWN items; removing anyone else's requires
    // editor+ (design: "contributor edits only own items; editor edits any").
    if (item.contributedBy !== callerId) {
      await assertSpaceRole(db, spaceId, callerId, "editor");
    }

    // Reference row only — the underlying file/memory is never touched (design §Security
    // #5: "Removing an item from a space never deletes the underlying resource").
    await db.delete(spaceItems).where(eq(spaceItems.id, itemId));

    return c.json({ removed: true, id: itemId });
  })
);
