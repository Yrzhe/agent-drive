import { isNull, sql } from "drizzle-orm";

import { files } from "@defs";

import type { AppDb } from "../types";

// Defaults (both tunable at runtime via the MAX_FILE_BYTES / MAX_TOTAL_BYTES vars;
// set a var to "0" to disable that limit). Values are binary (MiB/GiB).
const DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MiB
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

/** MCP `write_file` streams text through Worker memory — keep it modest and fixed. */
export const MCP_WRITE_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

function resolveLimit(raw: string | null | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return fallback; // NaN / negative / Infinity → default
  return parsed === 0 ? Number.POSITIVE_INFINITY : Math.floor(parsed); // 0 = unlimited; whole bytes only
}

async function maxFileBytes(): Promise<number> {
  const { vars } = await import("edgespark");
  return resolveLimit(vars.get("MAX_FILE_BYTES"), DEFAULT_MAX_FILE_BYTES);
}

async function maxTotalBytes(): Promise<number> {
  const { vars } = await import("edgespark");
  return resolveLimit(vars.get("MAX_TOTAL_BYTES"), DEFAULT_MAX_TOTAL_BYTES);
}

/**
 * Active (non-trashed) storage usage in bytes. Trashed files are excluded — they
 * still occupy R2 but are pending their 30-day hard purge, so they don't count
 * against the live quota.
 */
export async function currentUsageBytes(db: AppDb): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${files.size}), 0)` })
    .from(files)
    .where(isNull(files.deletedAt));
  return Number(row?.total ?? 0);
}

export interface QuotaCheck {
  ok: boolean;
  code: "file_too_large" | "quota_exceeded" | "";
  message: string;
}

const OK: QuotaCheck = { ok: true, code: "", message: "" };

/** Reject a single object larger than the per-file limit. */
export async function checkFileSize(size: number): Promise<QuotaCheck> {
  const max = await maxFileBytes();
  if (size > max) {
    return { ok: false, code: "file_too_large", message: `File is ${size} bytes; the per-file limit is ${max} bytes` };
  }
  return OK;
}

/** Reject when adding `addBytes` would push active usage past the total quota. */
export async function checkTotalQuota(db: AppDb, addBytes: number): Promise<QuotaCheck> {
  const max = await maxTotalBytes();
  if (!Number.isFinite(max)) return OK;
  const used = await currentUsageBytes(db);
  if (used + addBytes > max) {
    return { ok: false, code: "quota_exceeded", message: `Storage quota exceeded: ${used} + ${addBytes} > ${max} bytes` };
  }
  return OK;
}
