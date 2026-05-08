import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { webhooks } from "@defs";

import { hmacSha256Hex } from "./crypto";
import { nowIso } from "./files";
import type { AppDb, WebhookRow } from "../types";

const MAX_WEBHOOK_FAILURES = 5;
const WEBHOOK_RETRY_DELAY_MS = 2_000;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWebhook(url: string, eventType: string, payload: string, signature: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature": `sha256=${signature}`,
      "X-Agent-Drive-Event": eventType,
    },
    body: payload,
  });
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
    let response = await postWebhook(webhook.url, event.eventType, payload, signature);
    if (response.status >= 500) {
      await sleep(WEBHOOK_RETRY_DELAY_MS);
      response = await postWebhook(webhook.url, event.eventType, payload, signature);
    }
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
