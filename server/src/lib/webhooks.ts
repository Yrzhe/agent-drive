import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { webhooks } from "@defs";

import { hmacSha256Hex } from "./crypto";
import { nowIso } from "./files";
import type { AppDb, WebhookRow } from "../types";

const MAX_WEBHOOK_FAILURES = 5;

function parseEventTypes(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

export function createWebhookSecret(): string {
  return nanoid(32);
}

export async function deliverWebhook(
  db: AppDb,
  webhook: WebhookRow,
  event: { eventType: string; data: Record<string, unknown> | null }
): Promise<void> {
  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({
    event: event.eventType,
    timestamp,
    data: event.data,
  });
  const signature = await hmacSha256Hex(webhook.secret, payload);

  let status = 0;
  let failed = false;
  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Drive-Signature": `sha256=${signature}`,
        "X-Agent-Drive-Event": event.eventType,
      },
      body: payload,
    });
    status = response.status;
    failed = !response.ok;
  } catch (error) {
    failed = true;
    console.error("Failed to deliver webhook", { webhookId: webhook.id, eventType: event.eventType, error });
  }

  const nextFailureCount = failed ? webhook.failureCount + 1 : 0;
  try {
    await db
      .update(webhooks)
      .set({
        lastTriggeredAt: nowIso(),
        lastStatus: status || null,
        failureCount: nextFailureCount,
        enabled: nextFailureCount >= MAX_WEBHOOK_FAILURES ? 0 : webhook.enabled,
      })
      .where(eq(webhooks.id, webhook.id));
  } catch (error) {
    console.error("Failed to update webhook delivery status", { webhookId: webhook.id, eventType: event.eventType, error });
  }
}

export async function triggerWebhooks(
  db: AppDb,
  event: { eventType: string; data: Record<string, unknown> | null }
): Promise<void> {
  const rows = await db.select().from(webhooks).where(eq(webhooks.enabled, 1)).orderBy(desc(webhooks.createdAt));
  const matched = rows.filter((webhook) => parseEventTypes(webhook.eventTypes).includes(event.eventType));
  await Promise.all(matched.map((webhook) => deliverWebhook(db, webhook, event)));
}

export async function getWebhookById(db: AppDb, id: string): Promise<WebhookRow | null> {
  const [row] = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
  return row ?? null;
}
