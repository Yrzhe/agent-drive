import { and, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";

import { esSystemAuthUser, files, memories, spaceItems, spaceMembers, spaces } from "@defs";

import type { AppDb } from "../types";
import { resolveAccessStatus } from "./access";
import { ApiError } from "./errors";
import { nowIso } from "./files";
import { getMemory } from "./memory";
import { resolveOwnerUserId } from "./owner";
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
 * Shared Spaces P2 (D3): the public commons.
 *
 * Exactly ONE instance-wide `visibility='public'` space exists. Its id is a fixed constant
 * rather than a nanoid so the primary key itself is the uniqueness guard — two concurrent
 * bootstraps cannot produce two commons rows, they collide on the PK.
 *
 * NOTE: `"public-commons"` is a RESERVED space id. A pre-existing NON-public row under this
 * id would permanently block bootstrap (the insert conflicts, and `findPublicCommonsId`
 * still finds nothing). Unreachable in practice — user-created space ids come from
 * `nanoid()`, which never produces this string.
 */
export const PUBLIC_COMMONS_ID = "public-commons";
const PUBLIC_COMMONS_NAME = "Public Commons";

/** The implicit role every ACTIVE user holds in the commons (D3: contributor, never editor). */
const PUBLIC_IMPLICIT_ROLE: SpaceRole = "contributor";

/**
 * The single public space's id, or `null` when none has been bootstrapped. READ-ONLY —
 * unlike `ensurePublicCommons` this never writes, because it sits on the hot read path
 * (`userSpaceIds` → `accessibleFileIds`/`accessibleMemoryIds` → every list/recall query)
 * and a read must never materialize a row.
 */
async function findPublicCommonsId(db: AppDb): Promise<string | null> {
  const [row] = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.visibility, "public")).limit(1);
  return row?.id ?? null;
}

/**
 * Resolve — and materialize if absent — the public commons, returning its space id.
 *
 * `creatorId` is the deployment owner (`resolveOwnerUserId`), which makes the owner the
 * commons `creator` → its sole moderator. **Fails closed**: when the owner cannot be
 * resolved (`OWNER_EMAIL` unset, no matching row, or a case-only-duplicate ambiguity) this
 * returns `null` and creates NOTHING. A misconfigured deployment gets no commons at all
 * rather than one owned by an arbitrarily-picked account — the same null policy
 * `resolveOwnerUserId` and `resolveAccessStatus` already encode.
 *
 * Race-safe by construction, mirroring `resolveAccessStatus`'s materialization: two
 * near-simultaneous first calls may both reach the "missing" branch, so the insert uses a
 * FIXED primary key plus `onConflictDoNothing()` (the loser no-ops instead of throwing),
 * and the id returned always comes from a re-select — never assumed from the possibly-lost
 * insert. A pre-existing public row under some other id (e.g. seeded) is returned as-is, so
 * a second `visibility='public'` row is never created either way.
 */
export async function ensurePublicCommons(db: AppDb): Promise<string | null> {
  const existing = await findPublicCommonsId(db);
  if (existing) return existing;

  const ownerId = await resolveOwnerUserId(db);
  if (ownerId === null) return null; // fail closed — no owner, no commons.

  const inserted = await db
    .insert(spaces)
    .values({
      id: PUBLIC_COMMONS_ID,
      name: PUBLIC_COMMONS_NAME,
      creatorId: ownerId,
      visibility: "public",
      createdAt: nowIso(),
    } as never)
    .onConflictDoNothing()
    .returning({ id: spaces.id });

  // Defensive orphan sweep. `space_items` has NO foreign key to `spaces` and
  // `PUBLIC_COMMONS_ID` is a fixed constant, so item rows can outlive the space row they
  // point at: a contribute that passes its role check just before `Clear commons` deletes
  // the space can land its item afterwards, and the next bootstrap would reuse the same id
  // and silently make that orphan live in the supposedly-fresh commons. A re-bootstrapped
  // commons must always start EMPTY, so sweep any leftovers here.
  //
  // Gated on `returning()` being non-empty — i.e. THIS call actually created the row. A
  // concurrent bootstrap that lost the `onConflictDoNothing` race gets no rows back and so
  // never sweeps, which is what keeps it from wiping items contributed to the winner's
  // commons in the moments after it was created.
  if (inserted.length > 0) {
    await db.delete(spaceItems).where(eq(spaceItems.spaceId, PUBLIC_COMMONS_ID));
  }

  return findPublicCommonsId(db);
}

/**
 * Whether implicit public membership may be granted to `userId`.
 *
 * Deliberately reuses `resolveAccessStatus` — the ONE notion of "active" the #30 access
 * gate already enforces — instead of inventing a second one, so a user suspended by the
 * admin loses commons access through exactly the same switch that denies their requests.
 * A bearer principal carries no email; `resolveAccessStatus` resolves it by id internally,
 * so passing `email: null` is correct here.
 */
async function isActiveUser(db: AppDb, userId: string): Promise<boolean> {
  return (await resolveAccessStatus(db, { id: userId, email: null })) === "active";
}

/** The stored `space_members.role`, or null when there is no row / the value is unknown. */
async function storedMemberRole(db: AppDb, spaceId: string, userId: string): Promise<SpaceRole | null> {
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
 * Resolve a user's role in a space. The creator always resolves 'creator' — no
 * `space_members` row is required or expected for the creator (see the `spaces` table
 * doc comment in db_schema.ts). Otherwise falls back to the stored `space_members.role`.
 * Returns null when the space doesn't exist or the user is neither creator nor member.
 *
 * P2 (D3) adds implicit membership for the public commons ONLY: in a `visibility='public'`
 * space an **active** user with NO row resolves `'contributor'`. A pending/suspended user
 * resolves null — implicit membership is granted on confirmed-active status, never on the
 * mere absence of a denial. Invite spaces are untouched: no active user ever gains implicit
 * access to one.
 *
 * An explicit `space_members` row on the commons is AUTHORITATIVE in **both** directions: it
 * is a deliberate act by the commons creator (the deployment owner, its moderator), so a
 * stored `viewer` demotes that user to read-only — the proportionate remedy for commons spam,
 * without globally suspending the account — and a stored `editor` promotes them. Only the
 * absence of a row falls back to the implicit `contributor` floor. Note that `editor` on a
 * public space grants ITEM moderation only: `canEditFileViaSpace` excludes public spaces
 * outright, so it never becomes a byte-level write into a contributor's file.
 */
export async function resolveSpaceRole(db: AppDb, spaceId: string, userId: string): Promise<SpaceRole | null> {
  const [space] = await db
    .select({ creatorId: spaces.creatorId, visibility: spaces.visibility })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1);
  if (!space) return null;
  if (space.creatorId === userId) return "creator";

  const stored = await storedMemberRole(db, spaceId, userId);
  if (space.visibility !== "public") return stored;

  if (!(await isActiveUser(db, userId))) return null;
  return stored ?? PUBLIC_IMPLICIT_ROLE;
}

/**
 * Every space id a user can reach: spaces they created, union spaces they were invited
 * into as a member, union the public commons when the user is active (P2 implicit
 * membership — no `space_members` row exists for it). Returns `[]` for a user with no
 * spaces at all — callers use this to build `inArray(...)` filters, and an empty array
 * there correctly adds nothing (never matches everything, which an unfiltered/undefined
 * condition would).
 *
 * Adding the commons here is the ONLY change the read path needs: `accessibleFileIds`/
 * `accessibleMemoryIds` fan out from these ids, so an EMPTY commons still yields `[]` and
 * `fileReadableFilter`/`memoryReadableFilter` still collapse to the strict owner filter —
 * which is what keeps #30 isolation intact.
 *
 * The active check gates the commons UNIFORMLY — including when an explicit `space_members`
 * row already put it in the set. Checking it only on the "not already present" branch would
 * let a suspended user holding an explicit commons row keep the commons here while
 * `resolveSpaceRole` correctly returned null for them, so the "role is never null for an id
 * from `userSpaceIds`" assumption its callers rely on would silently be false. The commons
 * CREATOR is exempt: `resolveSpaceRole` returns `'creator'` from `spaces.creatorId` before
 * any status check, so dropping it for them would reintroduce the same disagreement.
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

  const commonsId = await findPublicCommonsId(db);
  const isCommonsCreator = commonsId !== null && created.some((row) => row.id === commonsId);
  if (commonsId && !isCommonsCreator) {
    if (await isActiveUser(db, userId)) ids.add(commonsId);
    else ids.delete(commonsId);
  }

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
 * WRITE-side authorization for the Shared Spaces live-reference edit (design D1, Task 6):
 * true when `userId` may OVERWRITE the file `fileId` THROUGH a space — i.e. the file is a
 * directly-contributed `'file'` item, or a descendant of a contributed `'folder'` item, in
 * some space where the user is editor+ (the stored `editor` role, or the space creator).
 *
 * Contributors and viewers always get `false`, so relaxing `write_file` for this can never
 * widen writes below the editor role. It also only ever looks at spaces where the caller is
 * editor+, so a file the caller merely *reads* through a viewer/contributor membership is
 * not writable. Callers use this only AFTER establishing that `userId` does not own
 * `fileId` (owners take the normal owner-scoped write path unchanged).
 *
 * **`visibility='public'` spaces are excluded from the editor set entirely — both branches.**
 * Live-reference byte editing is an INVITE-space power only. The commons' `creatorId` is the
 * deployment owner, so without the `creatorId`-branch exclusion every file ANY user
 * contributes to the commons would become owner-writable in place (their S3 key, their
 * `ownerId`, their bytes replaced) — a byte-level write into a private file that its owner
 * only ever consented to *publish*. The `space_members`-branch exclusion closes the same hole
 * from the other side: an owner-granted `editor` row on the commons (which P2 uses for ITEM
 * moderation, see `resolveSpaceRole`) must not resurrect that write grant. Moderation means
 * removing the REFERENCE — never rewriting the bytes.
 */
export async function canEditFileViaSpace(db: AppDb, userId: string, fileId: string): Promise<boolean> {
  const created = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.creatorId, userId), ne(spaces.visibility, "public")));
  const editorOf = await db
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(and(eq(spaceMembers.userId, userId), eq(spaceMembers.role, "editor"), ne(spaces.visibility, "public")));

  const editorSpaceIds = new Set<string>();
  for (const row of created) editorSpaceIds.add(row.id);
  for (const row of editorOf) editorSpaceIds.add(row.spaceId);
  if (editorSpaceIds.size === 0) return false;

  const items = await db
    .select()
    .from(spaceItems)
    .where(inArray(spaceItems.spaceId, [...editorSpaceIds]));
  for (const item of items) {
    if (item.itemType === "file") {
      if (item.itemRef === fileId) return true;
      continue;
    }
    if (item.itemType === "folder") {
      const descendants = await expandFolderItemToFileIds(db, item.itemRef, item.contributedBy);
      if (descendants.includes(fileId)) return true;
    }
  }
  return false;
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
 * The memory twin of `fileReadableFilter` (design §Read-path change / §Security spine #1),
 * as a Drizzle `WHERE` condition to drop into any MEMORY read query in place of the bare
 * `ownerId ? eq(memories.ownerId, ownerId) : undefined` owner filter.
 *
 * Semantics, preserving #30 isolation exactly except for the one controlled hole:
 * - `userId === null` (legacy trust-any-session): return `undefined` — no scoping, matching
 *   the previous `ownerId ? … : undefined` behavior byte-for-byte.
 * - user has NO reachable space memories: return `eq(memories.ownerId, userId)` — IDENTICAL
 *   to the strict owner filter, so a non-member (or any caller with empty spaces) sees only
 *   their own rows. This is why the #30 isolation suites stay green: no memberships ⇒
 *   `accessibleMemoryIds` is `[]` ⇒ this reduces to the pre-Spaces filter.
 * - user has reachable space memories: return `owner_id = me OR memories.id ∈ accessibleMemoryIds`.
 *   The `inArray` set is computed per-caller from THIS user's active memberships only, so it can
 *   never widen to another owner's non-shared rows.
 *
 * USE ONLY ON READ PATHS (recall/list/get). Writes/mutations (remember/forget/rebuild-index)
 * stay strictly owner-scoped in P1 — do not use this there.
 */
export async function memoryReadableFilter(db: AppDb, userId: string | null): Promise<SQL | undefined> {
  if (!userId) return undefined;
  const ids = await accessibleMemoryIds(db, userId);
  if (ids.length === 0) return eq(memories.ownerId, userId);
  return or(eq(memories.ownerId, userId), inArray(memories.id, ids));
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
 *
 * Also enforces P2's D4 restriction: a `'folder'` may never be contributed to a
 * `visibility='public'` space, because a folder item expands to its whole live subtree on
 * read (`expandFolderItemToFileIds`) — every file added under it later would silently
 * become world-readable. Files and memory are contributed one explicit item at a time, so
 * they carry no such open-ended exposure. Invite spaces still accept folders. The guard
 * lives HERE, not in the route, so the REST and MCP contribute paths (which both funnel
 * through this function) are covered by one check.
 */
export async function resolveOwnedContributionRef(
  db: AppDb,
  spaceId: string,
  itemType: SpaceItemType,
  ref: string,
  callerId: string
): Promise<string> {
  if (itemType === "folder") {
    const [space] = await db
      .select({ visibility: spaces.visibility })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .limit(1);
    if (space?.visibility === "public") {
      throw new ApiError(
        400,
        "folders_not_allowed_in_public",
        "Public spaces accept files and memory only — contribute individual files instead of a folder."
      );
    }
  }

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

export type SpaceRow = typeof spaces.$inferSelect;

export interface SpaceSummary {
  id: string;
  name: string;
  visibility: string;
  creatorId: string;
  createdAt: string;
  role: SpaceRole;
  /** `null` on the public commons — its audience is "everyone on this drive", not a count. */
  memberCount: number | null;
  itemCount: number;
}

export interface SpaceCounts {
  memberCount: number | null;
  itemCount: number;
}

/**
 * memberCount includes the creator (who never has a `space_members` row of their own).
 *
 * For a `visibility='public'` space it is `null`, NOT a number: the commons materializes no
 * `space_members` rows, so counting them would report `1` — making the one space EVERY active
 * user can read look like the smallest, least-exposed space at exactly the moment a user is
 * deciding whether to publish into it. `null` means "everyone on this drive"; surfaces render
 * that phrase rather than a digit. Invite spaces are unchanged.
 */
export async function spaceCounts(db: AppDb, spaceId: string, visibility?: string): Promise<SpaceCounts> {
  const [[memberRow], [itemRow]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId)),
    db.select({ n: sql<number>`count(*)` }).from(spaceItems).where(eq(spaceItems.spaceId, spaceId)),
  ]);
  const resolvedVisibility = visibility ?? (await spaceVisibility(db, spaceId));
  return {
    memberCount: resolvedVisibility === "public" ? null : (memberRow?.n ?? 0) + 1,
    itemCount: itemRow?.n ?? 0,
  };
}

/** The stored `spaces.visibility`, or null when the space doesn't exist. */
async function spaceVisibility(db: AppDb, spaceId: string): Promise<string | null> {
  const [row] = await db.select({ visibility: spaces.visibility }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  return row?.visibility ?? null;
}

/** The `{ …, role, memberCount, itemCount }` shape shared by the REST and MCP space surfaces. */
export function toSpaceSummary(space: SpaceRow, role: SpaceRole, counts: SpaceCounts): SpaceSummary {
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

/**
 * Resolve an existing user's id from an email, case-insensitively. Never creates a user
 * (invite-by-email only targets existing accounts — design D2). Fails closed to the same
 * 404 on both "no match" and "ambiguous case-only-duplicate match", mirroring
 * `resolveOwnerUserId`'s ambiguity handling in lib/owner.ts — an invite must never silently
 * bind to an arbitrarily-picked duplicate row.
 */
export async function resolveUserIdByEmail(db: AppDb, email: string): Promise<string> {
  const rows = await db
    .select({ id: esSystemAuthUser.id })
    .from(esSystemAuthUser)
    .where(sql`lower(${esSystemAuthUser.email}) = lower(${email})`)
    .limit(2);
  if (rows.length !== 1) throw new ApiError(404, "user_not_found", "No user with that email exists");
  return rows[0].id;
}
