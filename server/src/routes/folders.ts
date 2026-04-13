import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { files } from "@defs";

import { getRequestActor, logEvent } from "../lib/activity";
import { ensureFolderChain, nowIso, toFileObject } from "../lib/files";
import { ApiError, withErrorHandling } from "../lib/errors";
import { joinPath, normalizeName, normalizePath } from "../lib/paths";

export const foldersRoutes = new Hono();

foldersRoutes.post(
  "/",
  withErrorHandling(async (c) => {
    const body = (await c.req.json()) as { name?: string; path?: string };
    const name = normalizeName(body.name);
    const parentPath = normalizePath(body.path ?? "/");

    const { db } = await import("edgespark");
    await ensureFolderChain(db, parentPath);

    const folderPath = joinPath(parentPath, name);
    const [conflict] = await db.select().from(files).where(eq(files.path, folderPath)).limit(1);
    if (conflict) throw new ApiError(409, "path_conflict", "Path already exists");

    const [folder] = await db
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
