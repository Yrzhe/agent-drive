import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { buckets, bundleVersions, files } from "@defs";

import { signWithIdentity } from "../lib/agent-identity";
import { ApiError, withErrorHandling } from "../lib/errors";
import { joinPath } from "../lib/paths";
import type { AppDb } from "../types";

export const publicBundlesRoutes = new Hono();

const MANIFEST_SIGNATURE_TTL_SECS = 300;

function getPublicId(c: { req: { param: (name: string) => string | undefined } }): string {
  const id = c.req.param("publicId");
  if (!id) throw new ApiError(400, "validation_error", "Missing path param: publicId");
  return id;
}

async function getPublishedBundle(db: AppDb, publicId: string) {
  const [row] = await db.select().from(bundleVersions).where(eq(bundleVersions.publicId, publicId)).limit(1);
  if (!row) throw new ApiError(404, "bundle_not_found", "No published bundle with this id");
  return row;
}

/** Relative paths listed in the CURRENT manifest — the only downloadable set. */
async function loadManifestPaths(db: AppDb, storage: typeof import("edgespark")["storage"], prefix: string): Promise<{ manifestBytes: Uint8Array; paths: Set<string> }> {
  const manifestPath = joinPath(prefix, "manifest.json");
  const [row] = await db.select().from(files).where(and(eq(files.path, manifestPath), isNull(files.deletedAt))).limit(1);
  if (!row?.s3Uri) throw new ApiError(404, "manifest_not_found", "Bundle manifest not found");
  const parsed = storage.tryParseS3Uri(row.s3Uri);
  if (!parsed) throw new ApiError(500, "storage_error", "Invalid manifest storage URI");
  const obj = await storage.from(buckets.drive).get(parsed.path);
  if (!obj) throw new ApiError(404, "manifest_not_found", "Bundle manifest object missing");
  const body = obj.body as unknown;
  const manifestBytes = body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(body as ArrayBuffer);
  let manifest: { files?: Array<{ path?: unknown }> };
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { files?: Array<{ path?: unknown }> };
  } catch {
    throw new ApiError(500, "manifest_invalid", "Bundle manifest is not valid JSON");
  }
  const paths = new Set<string>();
  for (const entry of manifest.files ?? []) {
    if (entry && typeof entry.path === "string") paths.add(entry.path);
  }
  return { manifestBytes, paths };
}

publicBundlesRoutes.get(
  "/:publicId/current",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const bundle = await getPublishedBundle(db, getPublicId(c));
    const { manifestBytes } = await loadManifestPaths(db, storage, bundle.prefix);
    const signature = await signWithIdentity(db, manifestBytes);
    const origin = new URL(c.req.url).origin;
    return c.json({
      publicId: bundle.publicId,
      versionId: bundle.currentVersionId,
      hash: bundle.hash,
      fileCount: bundle.fileCount,
      totalSize: bundle.totalSize,
      pushedAt: bundle.pushedAt,
      manifestUrl: `${origin}/api/public/b/${bundle.publicId}/manifest`,
      signature: {
        algorithm: "Ed25519",
        value: signature,
        signs: "the exact manifest bytes served by manifestUrl",
        publicKey: `${origin}/api/public/.well-known/agent.json (signing.publicKeyJwk)`,
      },
    });
  })
);

publicBundlesRoutes.get(
  "/:publicId/manifest",
  withErrorHandling(async (c) => {
    const { db, storage } = await import("edgespark");
    const bundle = await getPublishedBundle(db, getPublicId(c));
    const { manifestBytes } = await loadManifestPaths(db, storage, bundle.prefix);
    return new Response(manifestBytes, {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${MANIFEST_SIGNATURE_TTL_SECS}` },
    });
  })
);

publicBundlesRoutes.get(
  "/:publicId/file",
  withErrorHandling(async (c) => {
    const relPath = c.req.query("path");
    if (!relPath) throw new ApiError(400, "validation_error", "path query param is required");

    const { db, storage } = await import("edgespark");
    const bundle = await getPublishedBundle(db, getPublicId(c));
    const { paths } = await loadManifestPaths(db, storage, bundle.prefix);
    // Only manifest-listed relative paths are downloadable — never arbitrary
    // drive paths, and never .history snapshots.
    if (!paths.has(relPath)) throw new ApiError(404, "file_not_found", "Path is not part of the published bundle");

    // Defense in depth: the exact-match DB lookup below can never resolve a
    // traversal, but reject unsafe shapes outright so a future query change
    // cannot reintroduce it.
    if (relPath.startsWith("/") || relPath.includes("\\") || relPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new ApiError(400, "validation_error", "path must be a safe relative path");
    }
    const fullPath = joinPath(bundle.prefix, relPath);
    const [row] = await db
      .select()
      .from(files)
      .where(and(eq(files.path, fullPath), eq(files.isFolder, 0), isNull(files.deletedAt)))
      .limit(1);
    if (!row?.s3Uri) throw new ApiError(404, "file_not_found", "File not found in the bundle");
    const parsed = storage.tryParseS3Uri(row.s3Uri);
    if (!parsed) throw new ApiError(500, "storage_error", "Invalid storage URI");
    const { downloadUrl } = await storage.from(buckets.drive).createPresignedGetUrl(parsed.path, 600);
    return c.json({ path: relPath, size: row.size, contentType: row.contentType, downloadUrl, expiresInSecs: 600 });
  })
);
