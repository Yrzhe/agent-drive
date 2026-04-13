import { eq } from "drizzle-orm";

import { rateLimits } from "@defs";

import type { AppDb } from "../types";

export async function checkRateLimit(
  db: AppDb,
  key: string,
  maxAttempts: number,
  windowMs: number
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
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
      count: entry.count + 1,
      updatedAt: now,
    })
    .where(eq(rateLimits.key, key));
}

export async function clearRateLimit(db: AppDb, key: string): Promise<void> {
  await db.delete(rateLimits).where(eq(rateLimits.key, key));
}
