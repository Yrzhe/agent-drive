import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { files } from "../../src/defs";
import { ApiError } from "../../src/lib/errors";
import {
  accessibleFileIds,
  accessibleMemoryIds,
  assertSpaceRole,
  expandFolderItemToFileIds,
  resolveSpaceRole,
  userSpaceIds,
} from "../../src/lib/spaces";
import { resetRuntime, runtime, seedDriveFile, seedMemory, seedSpace, seedSpaceItem, seedSpaceMember } from "./edge-runtime";

async function folderIdAtPath(path: string): Promise<string> {
  const [row] = await runtime.db.select({ id: files.id }).from(files).where(eq(files.path, path)).limit(1);
  if (!row) throw new Error(`no folder row seeded at ${path}`);
  return row.id;
}

describe("lib/spaces core resolvers (Shared Spaces P1 Task 1)", () => {
  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  describe("resolveSpaceRole", () => {
    it("the creator always resolves 'creator', even without a space_members row", async () => {
      const spaceId = await seedSpace({ creatorId: "user-a" });
      expect(await resolveSpaceRole(runtime.db as never, spaceId, "user-a")).toBe("creator");
    });

    it("an invited member resolves their stored role", async () => {
      const spaceId = await seedSpace({ creatorId: "user-a" });
      await seedSpaceMember({ spaceId, userId: "user-b", role: "contributor", addedBy: "user-a" });
      expect(await resolveSpaceRole(runtime.db as never, spaceId, "user-b")).toBe("contributor");
    });

    it("a non-member resolves null", async () => {
      const spaceId = await seedSpace({ creatorId: "user-a" });
      await seedSpaceMember({ spaceId, userId: "user-b", role: "viewer", addedBy: "user-a" });
      expect(await resolveSpaceRole(runtime.db as never, spaceId, "user-c")).toBeNull();
    });

    it("an unknown space id resolves null", async () => {
      expect(await resolveSpaceRole(runtime.db as never, "does-not-exist", "user-a")).toBeNull();
    });
  });

  describe("userSpaceIds", () => {
    it("returns spaces the user created and spaces they were invited into", async () => {
      const created = await seedSpace({ creatorId: "user-a", name: "created by A" });
      const invitedInto = await seedSpace({ creatorId: "user-c", name: "created by C" });
      await seedSpaceMember({ spaceId: invitedInto, userId: "user-a", role: "viewer", addedBy: "user-c" });
      // A space A has nothing to do with must never appear.
      await seedSpace({ creatorId: "user-c", name: "unrelated" });

      const ids = await userSpaceIds(runtime.db as never, "user-a");
      expect(new Set(ids)).toEqual(new Set([created, invitedInto]));
    });

    it("returns [] for a user with no spaces", async () => {
      expect(await userSpaceIds(runtime.db as never, "lonely-user")).toEqual([]);
    });
  });

  describe("accessibleFileIds", () => {
    it("resolves a directly contributed file id and a folder item's descendant file ids", async () => {
      const ownerA = "user-a";
      await seedDriveFile({ id: "file-standalone", path: "/standalone.txt", ownerId: ownerA });
      await seedDriveFile({ id: "file-in-folder-1", path: "/proj/one.txt", ownerId: ownerA });
      await seedDriveFile({ id: "file-in-folder-2", path: "/proj/sub/two.txt", ownerId: ownerA });
      // A file NOT contributed to any space must never leak in.
      await seedDriveFile({ id: "file-private", path: "/private.txt", ownerId: ownerA });
      const folderId = await folderIdAtPath("/proj");

      const spaceId = await seedSpace({ creatorId: ownerA });
      await seedSpaceMember({ spaceId, userId: "user-b", role: "viewer", addedBy: ownerA });
      await seedSpaceItem({ spaceId, itemType: "file", itemRef: "file-standalone", contributedBy: ownerA });
      await seedSpaceItem({ spaceId, itemType: "folder", itemRef: folderId, contributedBy: ownerA });

      const ids = await accessibleFileIds(runtime.db as never, "user-b");
      expect(new Set(ids)).toEqual(new Set(["file-standalone", "file-in-folder-1", "file-in-folder-2"]));
    });

    it("returns [] for a user with no spaces (callers add nothing to their filter)", async () => {
      expect(await accessibleFileIds(runtime.db as never, "lonely-user")).toEqual([]);
    });
  });

  describe("accessibleMemoryIds", () => {
    it("resolves a contributed memory id; returns [] with no spaces", async () => {
      const ownerA = "user-a";
      const sharedMemId = await seedMemory({ id: "mem-shared", content: "shared note", ownerId: ownerA });
      await seedMemory({ id: "mem-private", content: "private note", ownerId: ownerA });

      const spaceId = await seedSpace({ creatorId: ownerA });
      await seedSpaceMember({ spaceId, userId: "user-b", role: "viewer", addedBy: ownerA });
      await seedSpaceItem({ spaceId, itemType: "memory", itemRef: sharedMemId, contributedBy: ownerA });

      expect(await accessibleMemoryIds(runtime.db as never, "user-b")).toEqual([sharedMemId]);
      expect(await accessibleMemoryIds(runtime.db as never, "lonely-user")).toEqual([]);
    });
  });

  describe("expandFolderItemToFileIds", () => {
    it("returns descendant file ids only — excludes soft-deleted rows and non-folder refs", async () => {
      const ownerA = "user-a";
      await seedDriveFile({ id: "kb-1", path: "/kb/one.txt", ownerId: ownerA });
      const deletedId = await seedDriveFile({ id: "kb-2", path: "/kb/two.txt", ownerId: ownerA });
      await runtime.db.update(files).set({ deletedAt: new Date().toISOString() }).where(eq(files.id, deletedId));
      const folderId = await folderIdAtPath("/kb");

      expect(await expandFolderItemToFileIds(runtime.db as never, folderId, ownerA)).toEqual(["kb-1"]);
      // Passing a non-folder file id (not a folder row) must not blow up — just yields [].
      expect(await expandFolderItemToFileIds(runtime.db as never, "kb-1", ownerA)).toEqual([]);
    });
  });

  describe("assertSpaceRole", () => {
    it("throws ApiError(403, 'space_forbidden') when the caller's role is below min", async () => {
      const spaceId = await seedSpace({ creatorId: "user-a" });
      await seedSpaceMember({ spaceId, userId: "user-b", role: "viewer", addedBy: "user-a" });

      await expect(assertSpaceRole(runtime.db as never, spaceId, "user-b", "contributor")).rejects.toThrow(ApiError);
      try {
        await assertSpaceRole(runtime.db as never, spaceId, "user-b", "editor");
        expect.fail("expected assertSpaceRole to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(403);
        expect((error as ApiError).code).toBe("space_forbidden");
      }
    });

    it("throws for a non-member regardless of min", async () => {
      const spaceId = await seedSpace({ creatorId: "user-a" });
      await expect(assertSpaceRole(runtime.db as never, spaceId, "user-c", "viewer")).rejects.toThrow(ApiError);
    });

    it("resolves (does not throw) when the caller's role is at or above min", async () => {
      const spaceId = await seedSpace({ creatorId: "user-a" });
      await seedSpaceMember({ spaceId, userId: "user-b", role: "editor", addedBy: "user-a" });

      await expect(assertSpaceRole(runtime.db as never, spaceId, "user-b", "viewer")).resolves.toBeUndefined();
      await expect(assertSpaceRole(runtime.db as never, spaceId, "user-b", "contributor")).resolves.toBeUndefined();
      await expect(assertSpaceRole(runtime.db as never, spaceId, "user-b", "editor")).resolves.toBeUndefined();
      await expect(assertSpaceRole(runtime.db as never, spaceId, "user-a", "creator")).resolves.toBeUndefined();
    });
  });
});
