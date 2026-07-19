import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { files, spaceItems, spaceMembers, spaces } from "@defs";

import type { AppDb } from "../types";
import { ApiError } from "./errors";
import { escapedDescendantPattern } from "./paths";

/**
 * Shared Spaces P1 (design: docs/implementation/2026-07-19-shared-spaces-design.md).
 *
 * Membership + role resolvers and item-id fan-out helpers — the foundation the read-path
 * union (Task 4/5) and the CRUD/MCP surfaces (Task 2/3/6) build on. This module does not
 * mutate any table; it only resolves what a given user is allowed to see.
 */

export type SpaceRole = "viewer" | "contributor" | "editor" | "creator";

/** Ordering used by `assertSpaceRole`: viewer < contributor < editor < creator. */
const ROLE_RANK: Record<SpaceRole, number> = {
  viewer: 0,
  contributor: 1,
  editor: 2,
  creator: 3,
};

type SpaceItemRow = typeof spaceItems.$inferSelect;

/**
 * Resolve a user's role in a space. The creator always resolves 'creator' — no
 * `space_members` row is required or expected for the creator (see the `spaces` table
 * doc comment in db_schema.ts). Otherwise falls back to the stored `space_members.role`.
 * Returns null when the space doesn't exist or the user is neither creator nor member.
 *
 * Public-space implicit membership (P2, D3/D4) is out of scope here — P1 spaces are
 * `'invite'` only, so a user with no explicit relationship to the space is simply not a
 * member.
 */
export async function resolveSpaceRole(db: AppDb, spaceId: string, userId: string): Promise<SpaceRole | null> {
  const [space] = await db.select({ creatorId: spaces.creatorId }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return null;
  if (space.creatorId === userId) return "creator";

  const [member] = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
    .limit(1);
  return (member?.role as SpaceRole | undefined) ?? null;
}

/**
 * Every space id a user can reach: spaces they created, union spaces they were invited
 * into as a member. Returns `[]` for a user with no spaces at all — callers use this to
 * build `inArray(...)` filters, and an empty array there correctly adds nothing (never
 * matches everything, which an unfiltered/undefined condition would).
 */
export async function userSpaceIds(db: AppDb, userId: string): Promise<string[]> {
  const created = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.creatorId, userId));
  const memberOf = await db
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, userId));

  const ids = new Set<string>();
  for (const row of created) ids.add(row.id);
  for (const row of memberOf) ids.add(row.spaceId);
  return [...ids];
}

/**
 * Descendant FILE ids (not the folder row itself, `isFolder = 0` only) under a folder
 * `space_items` entry — same path-prefix pattern `lib/trash.ts`'s `expandSubtree` uses,
 * owner-scoped to `ownerId` (the item's `contributedBy`, since the folder belongs to
 * whoever contributed it). Soft-deleted descendants are excluded. Returns `[]` when
 * `folderId` doesn't resolve to a live folder row owned by `ownerId` (defensive — a
 * `space_items` row should never reference a non-folder, but a caller passing a stale/
 * wrong id must not throw).
 */
export async function expandFolderItemToFileIds(db: AppDb, folderId: string, ownerId: string): Promise<string[]> {
  const [folder] = await db
    .select({ path: files.path, isFolder: files.isFolder })
    .from(files)
    .where(and(eq(files.id, folderId), eq(files.ownerId, ownerId), isNull(files.deletedAt)))
    .limit(1);
  if (!folder || folder.isFolder !== 1) return [];

  const descendants = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        sql`${files.path} LIKE ${escapedDescendantPattern(folder.path)} ESCAPE '\\'`,
        eq(files.ownerId, ownerId),
        eq(files.isFolder, 0),
        isNull(files.deletedAt)
      )
    );
  return descendants.map((row) => row.id);
}

async function itemsForUserSpaces(
  db: AppDb,
  userId: string,
  itemTypes: readonly SpaceItemRow["itemType"][]
): Promise<SpaceItemRow[]> {
  const spaceIds = await userSpaceIds(db, userId);
  if (spaceIds.length === 0) return [];
  return db
    .select()
    .from(spaceItems)
    .where(and(inArray(spaceItems.spaceId, spaceIds), inArray(spaceItems.itemType, itemTypes)));
}

/**
 * File ids reachable via any space the user belongs to: directly contributed `'file'`
 * items, plus every descendant file under a contributed `'folder'` item's subtree.
 * Returns `[]` when the user has no spaces (see `userSpaceIds`), so callers can safely
 * `inArray(files.id, accessibleFileIds(...))` and add nothing when there's nothing to add.
 */
export async function accessibleFileIds(db: AppDb, userId: string): Promise<string[]> {
  const items = await itemsForUserSpaces(db, userId, ["file", "folder"]);
  if (items.length === 0) return [];

  const ids = new Set<string>();
  for (const item of items) {
    if (item.itemType === "file") {
      ids.add(item.itemRef);
      continue;
    }
    const descendants = await expandFolderItemToFileIds(db, item.itemRef, item.contributedBy);
    for (const id of descendants) ids.add(id);
  }
  return [...ids];
}

/**
 * Memory ids reachable via any space the user belongs to (directly contributed `'memory'`
 * items). Returns `[]` when the user has no spaces.
 */
export async function accessibleMemoryIds(db: AppDb, userId: string): Promise<string[]> {
  const items = await itemsForUserSpaces(db, userId, ["memory"]);
  return [...new Set(items.map((item) => item.itemRef))];
}

/**
 * Throw `ApiError(403, 'space_forbidden', …)` unless the user's resolved role in the space
 * is at or above `min` (viewer < contributor < editor < creator). A non-member (null role)
 * always fails, regardless of `min`.
 */
export async function assertSpaceRole(db: AppDb, spaceId: string, userId: string, min: SpaceRole): Promise<void> {
  const role = await resolveSpaceRole(db, spaceId, userId);
  if (role === null || ROLE_RANK[role] < ROLE_RANK[min]) {
    throw new ApiError(403, "space_forbidden", "You do not have the required role in this space.");
  }
}
