import { inArray } from "drizzle-orm";
import { nanoid } from "nanoid";

import { files } from "@defs";

import type { AppDb, FileObject, FileRow } from "../types";
import { ApiError } from "./errors";
import { joinPath, normalizePath } from "./paths";

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

export async function ensureFolderChain(db: AppDb, targetPath: string): Promise<void> {
  const normalized = normalizePath(targetPath);
  if (normalized === "/") return;

  const segments = normalized.slice(1).split("/").filter(Boolean);
  const folderPaths: string[] = [];
  let cursor = "/";
  for (const segment of segments) {
    cursor = joinPath(cursor, segment);
    folderPaths.push(cursor);
  }

  const existingRows = await db
    .select({ path: files.path, isFolder: files.isFolder })
    .from(files)
    .where(inArray(files.path, folderPaths));
  const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

  for (const [index, folderPath] of folderPaths.entries()) {
    const existing = existingByPath.get(folderPath);
    if (existing) {
      if (existing.isFolder !== 1) {
        throw new ApiError(409, "path_conflict", `Path already exists as file: ${folderPath}`);
      }
      continue;
    }

    const timestamp = nowIso();
    const segment = segments[index]!;
    const parentPath = index === 0 ? "/" : folderPaths[index - 1]!;
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
    });
  }
}
