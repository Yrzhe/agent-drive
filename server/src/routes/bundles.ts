import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { buckets, bundleVersions, files } from "@defs";

import { getRequestActor, logEvent } from "../lib/activity";
import { ApiError, withErrorHandling } from "../lib/errors";
import { ensureFolderChain, nowIso } from "../lib/files";
import { joinPath, normalizePath } from "../lib/paths";
import type { AppDb } from "../types";

export const bundlesRoutes = new Hono();

interface ManifestFileEntry {
  path: string;
  size: number;
  hash: string;
}

interface CommitRequestBody {
  prefix?: unknown;
  ifMatch?: unknown;
  manifest?: unknown;
}

interface ValidatedManifest {
  version: 1;
  name?: string;
  hash: string;
  machineId: string;
  fileCount: number;
  totalSize: number;
  files: ManifestFileEntry[];
  directories: string[];
}

function newVersionId(): string {
  return `dv_${nanoid(10)}`;
}

function isUniqueViolation(error: unknown, table: string): boolean {
  const message = (error as { message?: string } | null)?.message?.toLowerCase() ?? "";
  return message.includes("unique constraint failed") && message.includes(table);
}

function validateManifest(input: unknown): ValidatedManifest {
  if (!input || typeof input !== "object") {
    throw new ApiError(400, "validation_error", "manifest required");
  }
  const candidate = input as Record<string, unknown>;
  if (candidate.version !== 1) throw new ApiError(400, "validation_error", "manifest.version must be 1");
  if (typeof candidate.hash !== "string" || candidate.hash.length === 0) {
    throw new ApiError(400, "validation_error", "manifest.hash required");
  }
  if (typeof candidate.machineId !== "string" || candidate.machineId.length === 0) {
    throw new ApiError(400, "validation_error", "manifest.machineId required");
  }
  if (!Array.isArray(candidate.files)) {
    throw new ApiError(400, "validation_error", "manifest.files must be an array");
  }
  const fileList = candidate.files.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ApiError(400, "validation_error", `manifest.files[${index}] invalid`);
    }
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string") throw new ApiError(400, "validation_error", `manifest.files[${index}].path required`);
    if (typeof file.hash !== "string") throw new ApiError(400, "validation_error", `manifest.files[${index}].hash required`);
    if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size < 0) {
      throw new ApiError(400, "validation_error", `manifest.files[${index}].size invalid`);
    }
    return { path: file.path, hash: file.hash, size: file.size };
  });
  const totalSize = typeof candidate.totalSize === "number" && Number.isFinite(candidate.totalSize)
    ? candidate.totalSize
    : fileList.reduce((sum, file) => sum + file.size, 0);
  return {
    version: 1,
    name: typeof candidate.name === "string" ? candidate.name : undefined,
    hash: candidate.hash,
    machineId: candidate.machineId,
    fileCount: typeof candidate.fileCount === "number" ? candidate.fileCount : fileList.length,
    totalSize,
    files: fileList,
    directories: Array.isArray(candidate.directories)
      ? candidate.directories.filter((d): d is string => typeof d === "string")
      : [],
  };
}

function parseIfMatch(raw: unknown): { mode: "force" } | { mode: "any" } | { mode: "match"; value: string } {
  if (raw === "*") return { mode: "force" };
  if (raw === undefined || raw === null) return { mode: "any" };
  if (typeof raw === "string" && raw.length > 0) return { mode: "match", value: raw };
  throw new ApiError(400, "validation_error", "ifMatch must be a string, '*', or null");
}

function versionConflictResponse(currentVersionId: string | null, message: string) {
  return {
    error: {
      code: "version_conflict",
      message,
      currentVersionId,
    },
  } as const;
}

type StorageClientLike = {
  from: typeof import("edgespark")["storage"]["from"];
  tryParseS3Uri: typeof import("edgespark")["storage"]["tryParseS3Uri"];
  createS3Uri: typeof import("edgespark")["storage"]["createS3Uri"];
};

async function snapshotCurrentManifestToHistory(
  db: AppDb,
  storage: StorageClientLike,
  prefix: string,
  previousVersionId: string,
  pushedAt: string
): Promise<{ filesRow: typeof files.$inferInsert; existingId: string | null; bytes: Uint8Array } | null> {
  const manifestPath = joinPath(prefix, "manifest.json");
  const [currentManifestRow] = await db.select().from(files).where(eq(files.path, manifestPath)).limit(1);
  if (!currentManifestRow?.s3Uri) return null;

  const parsed = storage.tryParseS3Uri(currentManifestRow.s3Uri);
  if (!parsed) return null;
  const obj = await storage.from(buckets.drive).get(parsed.path);
  if (!obj) return null;

  const body = obj.body as unknown;
  const bytes = body instanceof Uint8Array
    ? new Uint8Array(body)
    : new Uint8Array(body as ArrayBuffer);

  const historyDir = joinPath(prefix, ".history");
  const historyPath = joinPath(historyDir, `${previousVersionId}.json`);
  const historyName = `${previousVersionId}.json`;

  const [existingHistoryRow] = await db.select().from(files).where(eq(files.path, historyPath)).limit(1);
  const historyFileId = existingHistoryRow?.id ?? nanoid();
  const historyR2Path = `${historyFileId}/${encodeURIComponent(historyName)}`;
  await storage.from(buckets.drive).put(historyR2Path, bytes, { contentType: "application/json" });

  const row: typeof files.$inferInsert = {
    id: historyFileId,
    name: historyName,
    path: historyPath,
    parentPath: historyDir,
    isFolder: 0,
    size: bytes.byteLength,
    contentType: "application/json",
    s3Uri: storage.createS3Uri(buckets.drive, historyR2Path),
    createdAt: existingHistoryRow?.createdAt ?? pushedAt,
    updatedAt: pushedAt,
  };

  return { filesRow: row, existingId: existingHistoryRow?.id ?? null, bytes };
}

bundlesRoutes.post(
  "/commit",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const body = (await c.req.json()) as CommitRequestBody;

    if (typeof body.prefix !== "string") {
      throw new ApiError(400, "validation_error", "prefix required");
    }
    const prefix = normalizePath(body.prefix);
    if (prefix === "/") {
      throw new ApiError(400, "validation_error", "prefix must be a non-root path");
    }
    if (prefix.includes("/.history/") || prefix.endsWith("/.history")) {
      throw new ApiError(400, "validation_error", "prefix cannot target the .history directory");
    }

    const ifMatch = parseIfMatch(body.ifMatch);
    const manifest = validateManifest(body.manifest);

    const [current] = await db
      .select()
      .from(bundleVersions)
      .where(eq(bundleVersions.prefix, prefix))
      .limit(1);
    const currentVersionId = current?.currentVersionId ?? null;

    if (ifMatch.mode !== "force") {
      if (current) {
        if (ifMatch.mode === "any") {
          return c.json(
            versionConflictResponse(
              currentVersionId,
              `Cloud bundle is at ${currentVersionId}; pass ifMatch to confirm you saw this version (or ifMatch: "*" to force)`
            ),
            412
          );
        }
        if (ifMatch.mode === "match" && ifMatch.value !== current.currentVersionId) {
          return c.json(
            versionConflictResponse(
              currentVersionId,
              `Cloud bundle moved to ${currentVersionId} since your last sync (you saw ${ifMatch.value})`
            ),
            412
          );
        }
      } else if (ifMatch.mode === "match") {
        return c.json(
          versionConflictResponse(
            null,
            `Cloud bundle does not exist; pass ifMatch: null (or omit) for fresh push`
          ),
          412
        );
      }
    }

    const versionId = newVersionId();
    const previousVersionId = current?.currentVersionId ?? null;
    const pushedAt = nowIso();
    const manifestPath = joinPath(prefix, "manifest.json");
    const manifestName = "manifest.json";

    const fullManifest = {
      version: 1 as const,
      name: manifest.name,
      hash: manifest.hash,
      machineId: manifest.machineId,
      pushedAt,
      versionId,
      previousVersionId,
      fileCount: manifest.fileCount,
      totalSize: manifest.totalSize,
      files: manifest.files,
      directories: manifest.directories,
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(fullManifest, null, 2));

    await ensureFolderChain(db, prefix);

    let historySnapshot: Awaited<ReturnType<typeof snapshotCurrentManifestToHistory>> = null;
    if (current && previousVersionId) {
      historySnapshot = await snapshotCurrentManifestToHistory(db, storage, prefix, previousVersionId, pushedAt);
      if (historySnapshot) {
        await ensureFolderChain(db, joinPath(prefix, ".history"));
      }
    }

    const [existingManifestRow] = await db
      .select()
      .from(files)
      .where(eq(files.path, manifestPath))
      .limit(1);

    if (existingManifestRow?.isFolder === 1) {
      throw new ApiError(409, "path_conflict", `manifest.json path is a folder: ${manifestPath}`);
    }

    const manifestFileId = existingManifestRow?.id ?? nanoid();
    const manifestR2Path = `${manifestFileId}/${encodeURIComponent(manifestName)}`;
    await storage.from(buckets.drive).put(manifestR2Path, manifestBytes, { contentType: "application/json" });

    const manifestFileRow: typeof files.$inferInsert = {
      id: manifestFileId,
      name: manifestName,
      path: manifestPath,
      parentPath: prefix,
      isFolder: 0,
      size: manifestBytes.byteLength,
      contentType: "application/json",
      s3Uri: storage.createS3Uri(buckets.drive, manifestR2Path),
      createdAt: existingManifestRow?.createdAt ?? pushedAt,
      updatedAt: pushedAt,
    };

    const newVersionRow: typeof bundleVersions.$inferInsert = {
      prefix,
      currentVersionId: versionId,
      previousVersionId,
      machineId: manifest.machineId,
      hash: manifest.hash,
      fileCount: manifest.fileCount,
      totalSize: manifest.totalSize,
      pushedAt,
      updatedAt: pushedAt,
    };

    const manifestStmt = existingManifestRow
      ? db.update(files).set(manifestFileRow).where(eq(files.id, existingManifestRow.id)).returning()
      : db.insert(files).values(manifestFileRow).returning();

    const historyStmt = historySnapshot
      ? historySnapshot.existingId
        ? db.update(files).set(historySnapshot.filesRow).where(eq(files.id, historySnapshot.existingId)).returning()
        : db.insert(files).values(historySnapshot.filesRow).returning()
      : null;

    let versionStmtResult: typeof bundleVersions.$inferSelect[] = [];
    if (current) {
      const versionWhere = ifMatch.mode === "force"
        ? eq(bundleVersions.prefix, prefix)
        : and(eq(bundleVersions.prefix, prefix), eq(bundleVersions.currentVersionId, current.currentVersionId));

      const batchStatements = historyStmt
        ? [manifestStmt, historyStmt, db.update(bundleVersions).set(newVersionRow).where(versionWhere).returning()]
        : [manifestStmt, db.update(bundleVersions).set(newVersionRow).where(versionWhere).returning()];
      const batchResults = await db.batch(batchStatements as [typeof batchStatements[0], ...typeof batchStatements]);
      versionStmtResult = batchResults[batchResults.length - 1] as typeof bundleVersions.$inferSelect[];

      if (versionStmtResult.length === 0) {
        const [racedCurrent] = await db
          .select()
          .from(bundleVersions)
          .where(eq(bundleVersions.prefix, prefix))
          .limit(1);
        return c.json(
          versionConflictResponse(
            racedCurrent?.currentVersionId ?? null,
            `Cloud bundle moved to ${racedCurrent?.currentVersionId ?? "<unknown>"} mid-commit; retry after sync`
          ),
          412
        );
      }
    } else {
      try {
        const batchStatements = [manifestStmt, db.insert(bundleVersions).values(newVersionRow).returning()];
        const batchResults = await db.batch(batchStatements as [typeof batchStatements[0], ...typeof batchStatements]);
        versionStmtResult = batchResults[batchResults.length - 1] as typeof bundleVersions.$inferSelect[];
      } catch (error) {
        if (isUniqueViolation(error, "bundle_versions")) {
          const [racedCurrent] = await db
            .select()
            .from(bundleVersions)
            .where(eq(bundleVersions.prefix, prefix))
            .limit(1);
          return c.json(
            versionConflictResponse(
              racedCurrent?.currentVersionId ?? null,
              `Another commit created this bundle concurrently; retry after sync`
            ),
            412
          );
        }
        throw error;
      }
    }

    await logEvent(db, {
      eventType: "bundle.committed",
      targetType: "folder",
      targetPath: prefix,
      actor: await getRequestActor(),
      metadata: {
        versionId,
        previousVersionId,
        hash: manifest.hash,
        machineId: manifest.machineId,
        fileCount: manifest.fileCount,
        totalSize: manifest.totalSize,
        force: ifMatch.mode === "force",
      },
    });

    return c.json({
      versionId,
      previousVersionId,
      pushedAt,
      manifestPath,
      hash: manifest.hash,
      fileCount: manifest.fileCount,
      totalSize: manifest.totalSize,
    });
  })
);
