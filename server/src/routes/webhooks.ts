import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { webhooks } from "@defs";

import { getWebhookById, createWebhookSecret, deliverWebhook } from "../lib/webhooks";
import { ApiError, withErrorHandling } from "../lib/errors";
import { nowIso } from "../lib/files";

export const webhooksRoutes = new Hono();

function parseEventTypes(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ApiError(400, "validation_error", "eventTypes must be an array of strings");
  const eventTypes = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  if (eventTypes.length === 0) throw new ApiError(400, "validation_error", "eventTypes must contain at least one event type");
  return [...new Set(eventTypes)];
}

function toWebhookObject(row: typeof webhooks.$inferSelect) {
  let eventTypes: string[] = [];
  try {
    const parsed = JSON.parse(row.eventTypes) as unknown;
    if (Array.isArray(parsed)) eventTypes = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    eventTypes = [];
  }

  return {
    id: row.id,
    url: row.url,
    eventTypes,
    enabled: row.enabled === 1,
    lastTriggeredAt: row.lastTriggeredAt,
    lastStatus: row.lastStatus,
    failureCount: row.failureCount,
    createdAt: row.createdAt,
  };
}

webhooksRoutes.post(
  "/",
  withErrorHandling(async (c) => {
    const body = (await c.req.json()) as { url?: string; eventTypes?: unknown; secret?: string };
    const url = (body.url ?? "").trim();
    if (!url) throw new ApiError(400, "validation_error", "url is required");

    try {
      new URL(url);
    } catch {
      throw new ApiError(400, "validation_error", "url must be a valid URL");
    }

    const secret = body.secret?.trim() || createWebhookSecret();
    const eventTypes = parseEventTypes(body.eventTypes);

    const { db } = await import("edgespark");
    const [created] = await db
      .insert(webhooks)
      .values({
        id: nanoid(),
        url,
        eventTypes: JSON.stringify(eventTypes),
        secret,
        enabled: 1,
        lastTriggeredAt: null,
        lastStatus: null,
        failureCount: 0,
        createdAt: nowIso(),
      })
      .returning();

    return c.json({ webhook: { ...toWebhookObject(created), secret } }, 201);
  })
);

webhooksRoutes.get(
  "/",
  withErrorHandling(async (c) => {
    const { db } = await import("edgespark");
    const rows = await db.select().from(webhooks).orderBy(desc(webhooks.createdAt));
    return c.json({ webhooks: rows.map(toWebhookObject) });
  })
);

webhooksRoutes.delete(
  "/:id",
  withErrorHandling(async (c) => {
    const id = c.req.param("id");
    if (!id) throw new ApiError(400, "validation_error", "Missing path param: id");

    const { db } = await import("edgespark");
    const deleted = await db.delete(webhooks).where(eq(webhooks.id, id)).returning({ id: webhooks.id });
    if (deleted.length === 0) throw new ApiError(404, "webhook_not_found", "Webhook not found");
    return c.json({ success: true });
  })
);

webhooksRoutes.post(
  "/:id/test",
  withErrorHandling(async (c) => {
    const id = c.req.param("id");
    if (!id) throw new ApiError(400, "validation_error", "Missing path param: id");

    const { db, ctx } = await import("edgespark");
    const webhook = await getWebhookById(db, id);
    if (!webhook) throw new ApiError(404, "webhook_not_found", "Webhook not found");

    ctx.runInBackground(
      deliverWebhook(db, webhook, {
        eventType: "webhook.test",
        data: { webhookId: webhook.id, triggeredAt: new Date().toISOString() },
      })
    );

    return c.json({ success: true });
  })
);
