import { isNull, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import { activityLog, bundleVersions, contacts, files, memories, shares, webhooks } from "@defs";

import type { AppDb } from "../types";

/** The content tables that gained a nullable `owner_id` in Phase 1a. */
const OWNED_TABLES: { name: string; table: SQLiteTable; ownerCol: ReturnType<typeof sql> }[] = [
  { name: "files", table: files, ownerCol: sql`owner_id` },
  { name: "shares", table: shares, ownerCol: sql`owner_id` },
  { name: "memories", table: memories, ownerCol: sql`owner_id` },
  { name: "activity_log", table: activityLog, ownerCol: sql`owner_id` },
  { name: "webhooks", table: webhooks, ownerCol: sql`owner_id` },
  { name: "contacts", table: contacts, ownerCol: sql`owner_id` },
  { name: "bundle_versions", table: bundleVersions, ownerCol: sql`owner_id` },
];

export interface OwnerBackfillResult {
  ownerId: string;
  tables: Record<string, { updated: number; remainingNull: number }>;
  complete: boolean; // true when no NULL owner_id remains anywhere
}

/**
 * Assign every content row with a NULL `owner_id` to `ownerId`.
 *
 * Idempotent (keyed on `owner_id IS NULL`, so a second run updates nothing) and
 * behaviour-neutral in Phase 1a — nothing filters by owner yet. New rows may still write
 * NULL until Phase 2 populates owner on insert; Phase 2 re-runs this to sweep them before
 * enabling filtering. At the current single-owner scale (~1.2k rows) a single pass per
 * table is far under D1's statement cap; larger deployments would batch by keyset.
 */
export async function backfillOwnerId(db: AppDb, ownerId: string): Promise<OwnerBackfillResult> {
  const tables: OwnerBackfillResult["tables"] = {};
  let complete = true;
  for (const { name, table, ownerCol } of OWNED_TABLES) {
    const updated = await db
      .update(table)
      .set({ ownerId } as never)
      .where(isNull(ownerCol as never))
      .returning({ id: sql<string>`1` });
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .where(isNull(ownerCol as never));
    tables[name] = { updated: updated.length, remainingNull: Number(n) };
    if (Number(n) > 0) complete = false;
  }
  return { ownerId, tables, complete };
}
