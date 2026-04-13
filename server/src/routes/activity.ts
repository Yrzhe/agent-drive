import { Hono } from "hono";

import { listActivities, parseActivityMetadata } from "../lib/activity";
import { ApiError, withErrorHandling } from "../lib/errors";

export const activityRoutes = new Hono();

activityRoutes.get(
  "/",
  withErrorHandling(async (c) => {
    const type = c.req.query("type")?.trim() || null;
    const since = c.req.query("since")?.trim() || null;
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;

    if (since) {
      const parsed = Date.parse(since);
      if (!Number.isFinite(parsed)) throw new ApiError(400, "validation_error", "since must be a valid ISO timestamp");
    }

    const { db } = await import("edgespark");
    const activities = await listActivities(db, { type, since, limit });

    return c.json({
      activities: activities.map((row) => ({
        id: row.id,
        eventType: row.eventType,
        targetType: row.targetType,
        targetId: row.targetId,
        targetPath: row.targetPath,
        actor: row.actor,
        metadata: parseActivityMetadata(row),
        createdAt: row.createdAt,
      })),
    });
  })
);
