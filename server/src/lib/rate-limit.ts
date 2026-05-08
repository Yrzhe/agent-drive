import { eq, lt, sql } from "drizzle-orm";

import { rateLimits } from "@defs";

import type { AppDb } from "../types";

const CLEANUP_SAMPLE_RATE = 0.01;
const STALE_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;

export async function checkRateLimit(
  db: AppDb,
  key: string,
  maxAttempts: number,
  windowMs: number
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  if (Math.random() < CLEANUP_SAMPLE_RATE) {
    await db.delete(rateLimits).where(lt(rateLimits.updatedAt, Date.now() - STALE_RATE_LIMIT_MS));
  }

  const [entry] = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);
  if (!entry) return { allowed: true };

  const now = Date.now();
  if (now - entry.firstAt >= windowMs) {
    return { allowed: true };
  }

  if (entry.count >= maxAttempts) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, entry.firstAt + windowMs - now),
    };
  }

  return { allowed: true };
}

export async function recordFailure(db: AppDb, key: string, windowMs: number): Promise<void> {
  const now = Date.now();
  const [entry] = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);

  if (!entry || now - entry.firstAt >= windowMs) {
    await db
      .insert(rateLimits)
      .values({
        key,
        count: 1,
        firstAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          count: 1,
          firstAt: now,
          updatedAt: now,
        },
      });
    return;
  }

  await db
    .update(rateLimits)
    .set({
      count: sql`${rateLimits.count} + 1`,
      updatedAt: now,
    })
    .where(eq(rateLimits.key, key));
}

export async function clearRateLimit(db: AppDb, key: string): Promise<void> {
  await db.delete(rateLimits).where(eq(rateLimits.key, key));
}
