import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { files } from "@defs";

import { getRequestActor, logEvent } from "../lib/activity";
import { ensureFolderChain, nowIso, toFileObject } from "../lib/files";
import { ApiError, withErrorHandling } from "../lib/errors";
import { joinPath, normalizeName, normalizePath } from "../lib/paths";
import { purgeConflictingTrashAtPath } from "../lib/trash";

export const foldersRoutes = new Hono();

function isPathUniqueConflict(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message?.toLowerCase() ?? "";
  return message.includes("unique constraint failed: files.path") || (message.includes("duplicate key") && message.includes("files.path"));
}

foldersRoutes.post(
  "/",
  withErrorHandling(async (c) => {
    const body = (await c.req.json()) as { name?: string; path?: string };
    const name = normalizeName(body.name);
    const parentPath = normalizePath(body.path ?? "/");

    const { db, storage } = await import("edgespark");
    await ensureFolderChain(db, parentPath);

    const folderPath = joinPath(parentPath, name);
    await purgeConflictingTrashAtPath(db, storage, folderPath);
    const [conflict] = await db.select().from(files).where(and(eq(files.path, folderPath), isNull(files.deletedAt))).limit(1);
    if (conflict) throw new ApiError(409, "path_conflict", "Path already exists");

    let folder: typeof files.$inferSelect | undefined;
    try {
      [folder] = await db
        .insert(files)
        .values({
          id: nanoid(),
          name,
          path: folderPath,
          parentPath,
          isFolder: 1,
          size: 0,
          contentType: null,
          s3Uri: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .returning();
    } catch (error) {
      if (isPathUniqueConflict(error)) {
        throw new ApiError(409, "path_conflict", "Path already exists");
      }
      throw error;
    }
    if (!folder) throw new ApiError(500, "internal_error", "Folder was not created");

    await logEvent(db, {
      eventType: "folder.created",
      targetType: "folder",
      targetId: folder.id,
      targetPath: folder.path,
      actor: await getRequestActor(),
      metadata: {
        parentPath,
      },
    });

    return c.json({ folder: toFileObject(folder) });
  })
);
