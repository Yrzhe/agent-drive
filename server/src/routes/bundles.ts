import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { buckets, bundleVersions, files } from "@defs";

import { getRequestActor, logEvent } from "../lib/activity";
import { driveObjectKey } from "../lib/object-keys";
import { ApiError, withErrorHandling } from "../lib/errors";
import { ensureFolderChain, nowIso } from "../lib/files";
import { joinPath, normalizePath } from "../lib/paths";
import { hasScope } from "../lib/mcp-scopes";
import { assertRestPathAllowed, getRestAuth } from "../lib/rest-scopes";
import { purgeConflictingTrashAtPath } from "../lib/trash";
import type { AppDb, AppEnv } from "../types";

export const bundlesRoutes = new Hono<AppEnv>();

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

type StorageClientLike = typeof import("edgespark")["storage"];

async function snapshotCurrentManifestToHistory(
  db: AppDb,
  storage: StorageClientLike,
  prefix: string,
  previousVersionId: string,
  pushedAt: string
): Promise<{ filesRow: typeof files.$inferInsert; existingId: string | null; bytes: Uint8Array } | null> {
  const manifestPath = joinPath(prefix, "manifest.json");
  const [currentManifestRow] = await db.select().from(files).where(and(eq(files.path, manifestPath), isNull(files.deletedAt))).limit(1);
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

  await purgeConflictingTrashAtPath(db, storage, historyPath);
  const [existingHistoryRow] = await db.select().from(files).where(and(eq(files.path, historyPath), isNull(files.deletedAt))).limit(1);
  const historyFileId = existingHistoryRow?.id ?? nanoid();
  const historyR2Path = driveObjectKey(historyFileId, historyName);
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
    deletedAt: null,
    createdAt: existingHistoryRow?.createdAt ?? pushedAt,
    updatedAt: pushedAt,
  };

  return { filesRow: row, existingId: existingHistoryRow?.id ?? null, bytes };
}

bundlesRoutes.post(
  "/publish",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const body = (await c.req.json().catch(() => ({}))) as { prefix?: unknown; public?: unknown };
    if (typeof body.prefix !== "string") throw new ApiError(400, "validation_error", "prefix required");
    if (typeof body.public !== "boolean") throw new ApiError(400, "validation_error", "public must be a boolean");
    const prefix = normalizePath(body.prefix);
    assertRestPathAllowed(c, prefix);
    // Publishing makes content world-readable — require share semantics, not
    // just write access, for bearer callers.
    const restAuth = getRestAuth(c);
    if (restAuth.kind === "bearer" && !hasScope(restAuth.scopes, "share:create")) {
      throw new ApiError(403, "invalid_scope", "invalid_scope:share:create");
    }

    const ownerFilter = ownerId ? eq(bundleVersions.ownerId, ownerId) : undefined;
    const [bundle] = await db.select().from(bundleVersions).where(and(eq(bundleVersions.prefix, prefix), ownerFilter)).limit(1);
    if (!bundle) throw new ApiError(404, "bundle_not_found", "No bundle committed at this prefix yet");

    const publicId = body.public ? bundle.publicId ?? `pb_${nanoid(16)}` : null;
    await db.update(bundleVersions).set({ publicId }).where(and(eq(bundleVersions.prefix, prefix), ownerFilter));

    await logEvent(db, {
      ownerId,
      eventType: body.public ? "bundle.published" : "bundle.unpublished",
      targetType: "folder",
      targetId: publicId ?? bundle.publicId,
      targetPath: prefix,
      actor: await getRequestActor(),
      metadata: { publicId: publicId ?? bundle.publicId },
    });

    const origin = new URL(c.req.url).origin;
    return c.json({
      prefix,
      public: body.public,
      publicId,
      subscribeUrl: publicId ? `${origin}/api/public/b/${publicId}/current` : null,
    });
  })
);

bundlesRoutes.post(
  "/commit",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
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
    assertRestPathAllowed(c, prefix);

    const ifMatch = parseIfMatch(body.ifMatch);
    const manifest = validateManifest(body.manifest);

    const ownerFilter = ownerId ? eq(bundleVersions.ownerId, ownerId) : undefined;
    const [current] = await db
      .select()
      .from(bundleVersions)
      .where(and(eq(bundleVersions.prefix, prefix), ownerFilter))
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

    await ensureFolderChain(db, prefix, ownerId);

    let historySnapshot: Awaited<ReturnType<typeof snapshotCurrentManifestToHistory>> = null;
    if (current && previousVersionId) {
      historySnapshot = await snapshotCurrentManifestToHistory(db, storage, prefix, previousVersionId, pushedAt);
      if (historySnapshot) {
        await ensureFolderChain(db, joinPath(prefix, ".history"), ownerId);
      }
    }

    await purgeConflictingTrashAtPath(db, storage, manifestPath);

    const [existingManifestRow] = await db
      .select()
      .from(files)
      .where(and(eq(files.path, manifestPath), isNull(files.deletedAt)))
      .limit(1);

    if (existingManifestRow?.isFolder === 1) {
      throw new ApiError(409, "path_conflict", `manifest.json path is a folder: ${manifestPath}`);
    }

    const manifestFileId = existingManifestRow?.id ?? nanoid();
    const manifestR2Path = driveObjectKey(manifestFileId, manifestName);
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
      deletedAt: null,
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
      : db.insert(files).values({ ...manifestFileRow, ownerId }).returning();

    const historyStmt = historySnapshot
      ? historySnapshot.existingId
        ? db.update(files).set(historySnapshot.filesRow).where(eq(files.id, historySnapshot.existingId)).returning()
        : db.insert(files).values({ ...historySnapshot.filesRow, ownerId }).returning()
      : null;

    let versionStmtResult: typeof bundleVersions.$inferSelect[] = [];
    if (current) {
      const versionWhere = ifMatch.mode === "force"
        ? and(eq(bundleVersions.prefix, prefix), ownerFilter)
        : and(eq(bundleVersions.prefix, prefix), eq(bundleVersions.currentVersionId, current.currentVersionId), ownerFilter);

      const batchStatements = historyStmt
        ? [manifestStmt, historyStmt, db.update(bundleVersions).set(newVersionRow).where(versionWhere).returning()]
        : [manifestStmt, db.update(bundleVersions).set(newVersionRow).where(versionWhere).returning()];
      const batchResults = await db.batch(batchStatements as [typeof batchStatements[0], ...typeof batchStatements]);
      versionStmtResult = batchResults[batchResults.length - 1] as typeof bundleVersions.$inferSelect[];

      if (versionStmtResult.length === 0) {
        const [racedCurrent] = await db
          .select()
          .from(bundleVersions)
          .where(and(eq(bundleVersions.prefix, prefix), ownerFilter))
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
        const batchStatements = [manifestStmt, db.insert(bundleVersions).values({ ...newVersionRow, ownerId }).returning()];
        const batchResults = await db.batch(batchStatements as [typeof batchStatements[0], ...typeof batchStatements]);
        versionStmtResult = batchResults[batchResults.length - 1] as typeof bundleVersions.$inferSelect[];
      } catch (error) {
        if (isUniqueViolation(error, "bundle_versions")) {
          const [racedCurrent] = await db
            .select()
            .from(bundleVersions)
            .where(and(eq(bundleVersions.prefix, prefix), ownerFilter))
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
      ownerId: c.get("ownerId") ?? null,
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

function requirePrefixQuery(value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "validation_error", "prefix query parameter required");
  }
  const prefix = normalizePath(value);
  if (prefix === "/") throw new ApiError(400, "validation_error", "prefix must be a non-root path");
  return prefix;
}

bundlesRoutes.get(
  "/current",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const prefix = requirePrefixQuery(c.req.query("prefix"));
    assertRestPathAllowed(c, prefix);

    const [row] = await db
      .select()
      .from(bundleVersions)
      .where(and(eq(bundleVersions.prefix, prefix), ownerId ? eq(bundleVersions.ownerId, ownerId) : undefined))
      .limit(1);

    if (!row) return c.json({ prefix, currentVersion: null });
    return c.json({
      prefix,
      currentVersion: {
        versionId: row.currentVersionId,
        previousVersionId: row.previousVersionId,
        machineId: row.machineId,
        hash: row.hash,
        fileCount: row.fileCount,
        totalSize: row.totalSize,
        pushedAt: row.pushedAt,
      },
    });
  })
);

interface HistoryManifestSummary {
  versionId: string;
  previousVersionId: string | null;
  hash: string;
  machineId: string;
  pushedAt: string;
  fileCount: number;
  totalSize: number;
}

function summariseManifest(raw: unknown, fallbackVersionIdFromName: string): HistoryManifestSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const versionId = typeof m.versionId === "string" ? m.versionId : fallbackVersionIdFromName;
  if (!versionId.startsWith("dv_")) return null;
  return {
    versionId,
    previousVersionId: typeof m.previousVersionId === "string" ? m.previousVersionId : null,
    hash: typeof m.hash === "string" ? m.hash : "",
    machineId: typeof m.machineId === "string" ? m.machineId : "",
    pushedAt: typeof m.pushedAt === "string" ? m.pushedAt : "",
    fileCount: typeof m.fileCount === "number" ? m.fileCount : 0,
    totalSize: typeof m.totalSize === "number" ? m.totalSize : 0,
  };
}

bundlesRoutes.get(
  "/history",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const prefix = requirePrefixQuery(c.req.query("prefix"));
    assertRestPathAllowed(c, prefix);
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 50;

    const historyDir = joinPath(prefix, ".history");
    const historyRows = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.parentPath, historyDir),
          eq(files.isFolder, 0),
          isNull(files.deletedAt),
          ownerId ? eq(files.ownerId, ownerId) : undefined
        )
      )
      .orderBy(desc(files.updatedAt))
      .limit(limit);

    const summaries: HistoryManifestSummary[] = [];
    for (const row of historyRows) {
      if (!row.s3Uri) continue;
      const parsed = storage.tryParseS3Uri(row.s3Uri);
      if (!parsed) continue;
      const obj = await storage.from(buckets.drive).get(parsed.path);
      if (!obj) continue;
      const body = obj.body as unknown;
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer);
      let parsedManifest: unknown;
      try {
        parsedManifest = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        continue;
      }
      const fallback = row.name.endsWith(".json") ? row.name.slice(0, -5) : row.name;
      const summary = summariseManifest(parsedManifest, fallback);
      if (summary) summaries.push(summary);
    }

    summaries.sort((a, b) => (b.pushedAt < a.pushedAt ? -1 : b.pushedAt > a.pushedAt ? 1 : 0));

    const [currentRow] = await db
      .select()
      .from(bundleVersions)
      .where(and(eq(bundleVersions.prefix, prefix), ownerId ? eq(bundleVersions.ownerId, ownerId) : undefined))
      .limit(1);

    return c.json({
      prefix,
      currentVersionId: currentRow?.currentVersionId ?? null,
      history: summaries,
    });
  })
);

interface RawManifestDownload {
  prefix: string;
  versionId: string;
  manifest: unknown;
}

bundlesRoutes.get(
  "/manifest",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const ownerId = c.get("ownerId") ?? null;
    const prefix = requirePrefixQuery(c.req.query("prefix"));
    assertRestPathAllowed(c, prefix);
    const versionId = c.req.query("versionId");
    if (typeof versionId !== "string" || !versionId.startsWith("dv_")) {
      throw new ApiError(400, "validation_error", "versionId query param required (must start with dv_)");
    }

    const [currentRow] = await db
      .select()
      .from(bundleVersions)
      .where(and(eq(bundleVersions.prefix, prefix), ownerId ? eq(bundleVersions.ownerId, ownerId) : undefined))
      .limit(1);

    const isCurrent = currentRow?.currentVersionId === versionId;
    const manifestFsPath = isCurrent
      ? joinPath(prefix, "manifest.json")
      : joinPath(prefix, `.history/${versionId}.json`);

    const [row] = await db
      .select()
      .from(files)
      .where(and(eq(files.path, manifestFsPath), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
      .limit(1);
    if (!row?.s3Uri) {
      throw new ApiError(404, "not_found", `Manifest for ${versionId} not found at ${manifestFsPath}`);
    }
    const parsed = storage.tryParseS3Uri(row.s3Uri);
    if (!parsed) throw new ApiError(500, "internal_error", "Manifest object has invalid S3 URI");
    const obj = await storage.from(buckets.drive).get(parsed.path);
    if (!obj) {
      throw new ApiError(404, "not_found", `Manifest body for ${versionId} missing from storage`);
    }
    const body = obj.body as unknown;
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer);
    let manifest: unknown;
    try {
      manifest = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ApiError(500, "internal_error", "Manifest body is not valid JSON");
    }

    const response: RawManifestDownload = { prefix, versionId, manifest };
    return c.json(response);
  })
);
