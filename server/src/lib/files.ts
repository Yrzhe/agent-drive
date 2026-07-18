import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";

import { files } from "@defs";

import type { AppDb, FileObject, FileRow } from "../types";
import { ApiError } from "./errors";
import { joinPath, normalizeName, normalizePath } from "./paths";

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * True when `error` is a unique-constraint violation on the files table's path uniqueness
 * (either the legacy plain `files.path` unique index, or the composite `(owner_id, path)`
 * unique index). Matches both SQLite ("UNIQUE constraint failed: files.owner_id, files.path")
 * and Postgres-style ("duplicate key ... files.path") error message shapes.
 */
export function isPathUniqueConflict(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message?.toLowerCase() ?? "";
  return (
    (message.includes("unique constraint failed") && message.includes("files.path")) ||
    (message.includes("duplicate key") && message.includes("files.path"))
  );
}

export function toFileObject(file: FileRow): FileObject {
  return {
    id: file.id,
    name: file.name,
    path: file.path,
    parentPath: file.parentPath,
    isFolder: file.isFolder === 1,
    size: file.size,
    contentType: file.contentType,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

export async function ensureFolderChain(db: AppDb, targetPath: string, ownerId: string | null = null): Promise<void> {
  const normalized = normalizePath(targetPath);
  if (normalized === "/") return;

  const segments = normalized.slice(1).split("/").filter(Boolean);
  const folderPaths: string[] = [];
  let cursor = "/";
  for (const segment of segments) {
    cursor = joinPath(cursor, normalizeName(segment));
    folderPaths.push(cursor);
  }

  const existingRows = await db
    .select({ id: files.id, path: files.path, isFolder: files.isFolder, deletedAt: files.deletedAt })
    .from(files)
    .where(and(inArray(files.path, folderPaths), ownerId ? eq(files.ownerId, ownerId) : undefined));
  const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

  for (const [index, folderPath] of folderPaths.entries()) {
    const existing = existingByPath.get(folderPath);
    if (existing) {
      if (existing.deletedAt) {
        // Soft-deleted folder occupies this path. Restore it (and its subtree) instead of inserting a fresh row.
        if (existing.isFolder !== 1) {
          throw new ApiError(409, "path_conflict", `Path is reserved by a trashed file: ${folderPath}`);
        }
        await db
          .update(files)
          .set({ deletedAt: null, updatedAt: nowIso() })
          .where(and(eq(files.id, existing.id), isNotNull(files.deletedAt)));
        continue;
      }
      if (existing.isFolder !== 1) {
        throw new ApiError(409, "path_conflict", `Path already exists as file: ${folderPath}`);
      }
      continue;
    }

    const timestamp = nowIso();
    const segment = segments[index];
    const parentPath = index === 0 ? "/" : folderPaths[index - 1];
    if (!segment || !parentPath) {
      throw new ApiError(400, "validation_error", "Folder path is invalid");
    }
    try {
      await db.insert(files).values({
        id: nanoid(),
        name: segment,
        path: folderPath,
        parentPath,
        isFolder: 1,
        size: 0,
        contentType: null,
        s3Uri: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        ownerId,
      });
    } catch (error) {
      if (isPathUniqueConflict(error)) {
        // Lost a concurrent race to create this folder for this owner — it now exists, so
        // treat as already-created and move on to the next path segment.
        continue;
      }
      throw error;
    }
  }
}
