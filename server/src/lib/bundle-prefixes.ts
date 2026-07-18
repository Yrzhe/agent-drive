import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { bundleVersions } from "@defs";

import type { AppDb } from "../types";
import { escapedDescendantPattern, normalizePath } from "./paths";

export function bundlePrefixSubtreeCondition(rootPath: string) {
  const normalized = normalizePath(rootPath);
  return or(
    eq(bundleVersions.prefix, normalized),
    sql`${bundleVersions.prefix} LIKE ${escapedDescendantPattern(normalized)} ESCAPE '\\'`
  );
}

export function rewriteBundlePrefixesForMove(
  db: AppDb,
  oldPath: string,
  nextPath: string,
  updatedAt: string,
  ownerId: string | null
) {
  const oldPrefix = normalizePath(oldPath);
  const nextPrefix = normalizePath(nextPath);
  return db
    .update(bundleVersions)
    .set({
      prefix: sql<string>`case when ${bundleVersions.prefix} = ${oldPrefix} then ${nextPrefix} else ${nextPrefix} || substr(${bundleVersions.prefix}, length(${oldPrefix}) + 1) end`,
      updatedAt,
    })
    .where(and(bundlePrefixSubtreeCondition(oldPrefix), ownerId ? eq(bundleVersions.ownerId, ownerId) : undefined));
}

export function unpublishBundlePrefixesInSubtree(db: AppDb, rootPath: string, updatedAt: string, ownerId: string | null) {
  return db
    .update(bundleVersions)
    .set({ publicId: null, updatedAt })
    .where(
      and(
        bundlePrefixSubtreeCondition(rootPath),
        isNotNull(bundleVersions.publicId),
        ownerId ? eq(bundleVersions.ownerId, ownerId) : undefined
      )
    );
}

export function deleteBundlePrefixesInSubtree(db: AppDb, rootPath: string, ownerId: string | null) {
  return db
    .delete(bundleVersions)
    .where(and(bundlePrefixSubtreeCondition(rootPath), ownerId ? eq(bundleVersions.ownerId, ownerId) : undefined));
}

export async function selectPublishedBundleRowsInSubtree(db: AppDb, rootPath: string, ownerId: string | null) {
  return db
    .select({ prefix: bundleVersions.prefix, publicId: bundleVersions.publicId })
    .from(bundleVersions)
    .where(
      and(
        bundlePrefixSubtreeCondition(rootPath),
        isNotNull(bundleVersions.publicId),
        ownerId ? eq(bundleVersions.ownerId, ownerId) : undefined
      )
    );
}
