import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { files } from "@defs";

import type { AppDb, FileObject, FileRow } from "../types";
import { ApiError } from "./errors";
import { joinPath, normalizeName, normalizePath } from "./paths";

export function nowIso(): string {
  return new Date().toISOString();
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

export function parseUploadObjectPath(storagePath: string): { parentPath: string; filename: string } {
  const parts = storagePath.split("/");
  if (parts.length < 3) {
    throw new ApiError(500, "internal_error", "Invalid upload object path");
  }

  const parentPath = normalizePath(decodeURIComponent(parts[1] ?? ""));
  const filename = normalizeName(decodeURIComponent(parts.slice(2).join("/")));
  return { parentPath, filename };
}

export async function ensureFolderChain(db: AppDb, targetPath: string): Promise<void> {
  const normalized = normalizePath(targetPath);
  if (normalized === "/") return;

  const segments = normalized.slice(1).split("/").filter(Boolean);
  let cursor = "/";

  for (const segment of segments) {
    const folderPath = joinPath(cursor, segment);
    const [existing] = await db.select().from(files).where(eq(files.path, folderPath)).limit(1);

    if (existing) {
      if (existing.isFolder !== 1) {
        throw new ApiError(409, "path_conflict", `Path already exists as file: ${folderPath}`);
      }
    } else {
      const timestamp = nowIso();
      await db.insert(files).values({
        id: nanoid(),
        name: segment,
        path: folderPath,
        parentPath: cursor,
        isFolder: 1,
        size: 0,
        contentType: null,
        s3Uri: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    cursor = folderPath;
  }
}
