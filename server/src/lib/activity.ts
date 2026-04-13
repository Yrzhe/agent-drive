import { and, desc, eq, gte } from "drizzle-orm";
import { nanoid } from "nanoid";

import { activityLog } from "@defs";

import { nowIso } from "./files";
import type { ActivityEventInput, ActivityLogRow, AppDb } from "../types";

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
    await db.insert(activityLog).values({
      id: nanoid(),
      eventType: event.eventType,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      targetPath: event.targetPath ?? null,
      actor: event.actor,
      metadata: serializeMetadata(event.metadata),
      createdAt,
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
