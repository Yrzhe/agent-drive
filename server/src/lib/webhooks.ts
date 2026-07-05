import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

import { webhooks } from "@defs";

import { hmacSha256Hex } from "./crypto";
import { nowIso } from "./files";
import type { AppDb, WebhookRow } from "../types";

const MAX_WEBHOOK_FAILURES = 5;
const WEBHOOK_RETRY_DELAY_MS = 2_000;
const DNS_QUERY_ENDPOINT = "https://cloudflare-dns.com/dns-query";

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

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/u, "");
}

function isPrivateOrReservedIpv4(value: string): boolean {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateOrReservedIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateOrReservedIpv4(normalized.slice("::ffff:".length));
  const firstGroup = normalized.split(":")[0] ?? "";
  const firstValue = Number.parseInt(firstGroup, 16);
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("2001:db8:")
    || (Number.isInteger(firstValue) && firstValue >= 0xfc00 && firstValue <= 0xfdff)
    || (Number.isInteger(firstValue) && firstValue >= 0xfe80 && firstValue <= 0xfebf)
    || (Number.isInteger(firstValue) && firstValue >= 0xff00 && firstValue <= 0xffff);
}

export function validateWebhookUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "url must be a valid URL";
  }

  if (parsed.protocol !== "https:") return "url must use https";
  const hostname = normalizeHostname(parsed.hostname);
  if (hostname.includes(":")) return "url cannot target IPv6 literals";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return "url cannot target IP literals";
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    return "url cannot target localhost or internal hosts";
  }

  return null;
}

async function resolveDnsRecords(hostname: string, type: "A" | "AAAA"): Promise<string[]> {
  const response = await fetch(`${DNS_QUERY_ENDPOINT}?${new URLSearchParams({ name: hostname, type }).toString()}`, {
    headers: { Accept: "application/dns-json" },
  });
  if (!response.ok) throw new Error(`DNS ${type} lookup failed with HTTP ${response.status}`);
  const body = await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
  if (body.Status !== 0) return [];
  const expectedType = type === "A" ? 1 : 28;
  return (body.Answer ?? [])
    .filter((answer) => answer.type === expectedType && typeof answer.data === "string")
    .map((answer) => answer.data!);
}

export async function validateWebhookUrlForDelivery(rawUrl: string): Promise<string | null> {
  const validationError = validateWebhookUrl(rawUrl);
  if (validationError) return validationError;

  const hostname = normalizeHostname(new URL(rawUrl).hostname);
  try {
    // Workers fetch does its own DNS resolution; this delivery-time DoH check
    // blocks obvious private/reserved destinations but cannot pin the later
    // fetch to the exact resolved IP.
    const [ipv4Records, ipv6Records] = await Promise.all([
      resolveDnsRecords(hostname, "A"),
      resolveDnsRecords(hostname, "AAAA"),
    ]);
    if (ipv4Records.length === 0 && ipv6Records.length === 0) {
      return "url hostname did not resolve to public IPs";
    }
    if (ipv4Records.some(isPrivateOrReservedIpv4) || ipv6Records.some(isPrivateOrReservedIpv6)) {
      return "url hostname resolves to a private or reserved IP";
    }
  } catch (error) {
    console.error("Failed to validate webhook DNS", { hostname, error });
    return "url hostname could not be resolved safely";
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Callers must run validateWebhookUrlForDelivery first; deliverWebhook is the only caller.
async function postValidatedWebhook(url: string, eventType: string, payload: string, signature: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    redirect: "manual",
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
    const validationError = await validateWebhookUrlForDelivery(webhook.url);
    if (validationError) throw new Error(`Blocked webhook URL: ${validationError}`);

    let response = await postValidatedWebhook(webhook.url, event.eventType, payload, signature);
    if (response.status >= 500) {
      await sleep(WEBHOOK_RETRY_DELAY_MS);
      response = await postValidatedWebhook(webhook.url, event.eventType, payload, signature);
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
