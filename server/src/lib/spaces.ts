import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { files, memories, spaceItems, spaceMembers, spaces } from "@defs";

import type { AppDb } from "../types";
import { ApiError } from "./errors";
import { getMemory } from "./memory";
import { escapedDescendantPattern, normalizePath } from "./paths";

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

export type SpaceItemRow = typeof spaceItems.$inferSelect;

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
  // Fail closed on any role value outside the known set: an unrecognized string would make
  // ROLE_RANK[role] undefined, and `undefined < min` is false — assertSpaceRole would NOT
  // throw, silently granting access. Treat an unknown role as no membership.
  const role = member?.role;
  return role && role in ROLE_RANK ? (role as SpaceRole) : null;
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
 * The Shared Spaces P1 read-path union (design §Read-path change / §Security spine #1),
 * as a Drizzle `WHERE` condition to drop into any FILE read query in place of the bare
 * `ownerId ? eq(files.ownerId, ownerId) : undefined` owner filter.
 *
 * Semantics, preserving #30 isolation exactly except for the one controlled hole:
 * - `userId === null` (legacy trust-any-session): return `undefined` — no scoping, matching
 *   the previous `ownerId ? … : undefined` behavior byte-for-byte.
 * - user has NO reachable space files: return `eq(files.ownerId, userId)` — IDENTICAL to the
 *   strict owner filter, so a non-member (or any caller with empty spaces) sees only their own
 *   rows. This is why the #30 isolation suites stay green: no spaces ⇒ `accessibleFileIds` is
 *   `[]` ⇒ this reduces to the pre-Spaces filter.
 * - user has reachable space files: return `owner_id = me OR files.id ∈ accessibleFileIds`.
 *   The `inArray` set is computed per-caller from THIS user's active memberships only, so it can
 *   never widen to another owner's non-shared rows.
 *
 * USE ONLY ON READ PATHS (list/get/read/search/download-presign). Writes/mutations
 * (rename/move/delete/overwrite/share/send) stay strictly owner-scoped in P1 — do not use this
 * there.
 */
export async function fileReadableFilter(db: AppDb, userId: string | null): Promise<SQL | undefined> {
  if (!userId) return undefined;
  const ids = await accessibleFileIds(db, userId);
  if (ids.length === 0) return eq(files.ownerId, userId);
  return or(eq(files.ownerId, userId), inArray(files.id, ids));
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

export type SpaceItemType = "file" | "folder" | "memory";

/**
 * Resolve a `POST /spaces/:id/items` `ref` (a file/folder path, or a memory id/key) to the
 * underlying `files.id` / `memories.id` — but ONLY when `callerId` owns that resource.
 * This is the P1 Task 3 security spine (design §Security #2): contributing an item is the
 * item owner's explicit action only, so a caller can never expose someone else's resource
 * into a space. Throws `ApiError(403, 'not_your_resource')` when `ref` doesn't resolve to a
 * live resource owned by `callerId` — deliberately the SAME error for "no such resource"
 * and "exists but belongs to someone else", so this endpoint never leaks whether a given
 * path/id exists under another owner.
 */
export async function resolveOwnedContributionRef(
  db: AppDb,
  itemType: SpaceItemType,
  ref: string,
  callerId: string
): Promise<string> {
  if (itemType === "memory") {
    const memory = await getMemory(db, ref, callerId);
    if (!memory) throw new ApiError(403, "not_your_resource", "You do not own a memory matching that ref");
    return memory.id;
  }

  const path = normalizePath(ref);
  const [row] = await db
    .select({ id: files.id, isFolder: files.isFolder })
    .from(files)
    .where(and(eq(files.path, path), eq(files.ownerId, callerId), isNull(files.deletedAt)))
    .limit(1);
  const wantsFolder = itemType === "folder";
  if (!row || (row.isFolder === 1) !== wantsFolder) {
    throw new ApiError(403, "not_your_resource", `You do not own a ${itemType} matching that ref`);
  }
  return row.id;
}

export interface SpaceItemDisplay {
  id: string;
  itemType: SpaceItemType;
  itemRef: string;
  name: string | null;
  contributedBy: string;
  addedAt: string;
}

const MEMORY_NAME_SNIPPET_CHARS = 80;

/**
 * Resolve the flat, attributed list shape for `GET /spaces/:id/items` (design: "Listing a
 * space is a FLAT, attributed list"). `name` comes from the underlying resource: a file/
 * folder's `files.name`, or a memory's `key` (falling back to a content snippet when the
 * memory has no key). A `name` of `null` means the underlying resource is gone (hard-
 * deleted) — the item row itself is untouched; a stale reference is not this function's
 * concern to clean up.
 */
export async function toDisplayItems(db: AppDb, items: readonly SpaceItemRow[]): Promise<SpaceItemDisplay[]> {
  const fileRefs = items.filter((item) => item.itemType === "file" || item.itemType === "folder").map((item) => item.itemRef);
  const memoryRefs = items.filter((item) => item.itemType === "memory").map((item) => item.itemRef);

  const fileNameById = new Map<string, string>();
  if (fileRefs.length > 0) {
    const rows = await db.select({ id: files.id, name: files.name }).from(files).where(inArray(files.id, fileRefs));
    for (const row of rows) fileNameById.set(row.id, row.name);
  }

  const memoryNameById = new Map<string, string>();
  if (memoryRefs.length > 0) {
    const rows = await db
      .select({ id: memories.id, key: memories.key, content: memories.content })
      .from(memories)
      .where(inArray(memories.id, memoryRefs));
    for (const row of rows) memoryNameById.set(row.id, row.key ?? row.content.slice(0, MEMORY_NAME_SNIPPET_CHARS));
  }

  return items.map((item) => ({
    id: item.id,
    itemType: item.itemType as SpaceItemType,
    itemRef: item.itemRef,
    name: (item.itemType === "memory" ? memoryNameById.get(item.itemRef) : fileNameById.get(item.itemRef)) ?? null,
    contributedBy: item.contributedBy,
    addedAt: item.addedAt,
  }));
}
