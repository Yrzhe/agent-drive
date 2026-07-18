import { and, desc, eq, gte, lt } from "drizzle-orm";
import { nanoid } from "nanoid";

import { activityLog } from "@defs";

import { nowIso } from "./files";
import { currentOwnerId } from "./request-owner";
import type { ActivityEventInput, ActivityLogRow, AppDb } from "../types";

const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_SAMPLE_RATE = 0.01;

function serializeMetadata(metadata: ActivityEventInput["metadata"]): string | null {
  if (metadata == null) return null;
  return JSON.stringify(metadata);
}

export function parseActivityMetadata(row: ActivityLogRow): Record<string, unknown> | null {
  if (!row.metadata) return null;
  try {
    return JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function getRequestActor(): Promise<ActivityEventInput["actor"]> {
  const { auth } = await import("edgespark/http");
  return auth.isAuthenticated() ? "owner" : "agent";
}

export async function logEvent(db: AppDb, event: ActivityEventInput): Promise<void> {
  try {
    const createdAt = nowIso();
    if (Math.random() < PRUNE_SAMPLE_RATE) {
      const cutoff = new Date(Date.now() - ACTIVITY_RETENTION_MS).toISOString();
      await db.delete(activityLog).where(lt(activityLog.createdAt, cutoff));
    }
    await db.insert(activityLog).values({
      id: nanoid(),
      eventType: event.eventType,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      targetPath: event.targetPath ?? null,
      actor: event.actor,
      metadata: serializeMetadata(event.metadata),
      ip: event.ip ?? null,
      userAgent: event.userAgent ?? null,
      createdAt,
      ownerId: currentOwnerId(),
    });
  } catch (error) {
    console.error("Failed to write activity log", { eventType: event.eventType, error });
  }

  try {
    const { ctx } = await import("edgespark");
    const { triggerWebhooks } = await import("./webhooks");
    ctx.runInBackground(
      triggerWebhooks(db, {
        eventType: event.eventType,
        data: {
          targetType: event.targetType ?? null,
          targetId: event.targetId ?? null,
          targetPath: event.targetPath ?? null,
          actor: event.actor,
          metadata: event.metadata ?? null,
        },
      }).catch((error) => {
        console.error("Failed to trigger webhooks", { eventType: event.eventType, error });
      })
    );
  } catch (error) {
    console.error("Failed to schedule webhooks", { eventType: event.eventType, error });
  }
}

export async function logEventsBatch(
  db: AppDb,
  events: ActivityEventInput[],
  webhookEvent?: { eventType: string; data: Record<string, unknown> | null }
): Promise<void> {
  if (events.length === 0) return;

  try {
    if (Math.random() < PRUNE_SAMPLE_RATE) {
      const cutoff = new Date(Date.now() - ACTIVITY_RETENTION_MS).toISOString();
      await db.delete(activityLog).where(lt(activityLog.createdAt, cutoff));
    }

    const inserts = events.map((event) => db.insert(activityLog).values({
      id: nanoid(),
      eventType: event.eventType,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      targetPath: event.targetPath ?? null,
      actor: event.actor,
      metadata: serializeMetadata(event.metadata),
      ip: event.ip ?? null,
      userAgent: event.userAgent ?? null,
      createdAt: nowIso(),
      ownerId: currentOwnerId(),
    }));
    await db.batch(inserts as [typeof inserts[number], ...Array<typeof inserts[number]>]);
  } catch (error) {
    console.error("Failed to write activity log batch", { count: events.length, error });
  }

  if (!webhookEvent) return;
  try {
    const { ctx } = await import("edgespark");
    const { triggerWebhooks } = await import("./webhooks");
    ctx.runInBackground(
      triggerWebhooks(db, webhookEvent).catch((error) => {
        console.error("Failed to trigger batch webhook", { eventType: webhookEvent.eventType, error });
      })
    );
  } catch (error) {
    console.error("Failed to schedule batch webhook", { eventType: webhookEvent.eventType, error });
  }
}

export async function listActivities(
  db: AppDb,
  filters: { type?: string | null; limit: number; since?: string | null }
): Promise<ActivityLogRow[]> {
  const clauses: ReturnType<typeof eq>[] = [];
  if (filters.type) clauses.push(eq(activityLog.eventType, filters.type));
  if (filters.since) clauses.push(gte(activityLog.createdAt, filters.since));

  if (clauses.length === 0) {
    return db.select().from(activityLog).orderBy(desc(activityLog.createdAt)).limit(filters.limit);
  }
  if (clauses.length === 1) {
    return db.select().from(activityLog).where(clauses[0]!).orderBy(desc(activityLog.createdAt)).limit(filters.limit);
  }
  return db.select().from(activityLog).where(and(...clauses)).orderBy(desc(activityLog.createdAt)).limit(filters.limit);
}
