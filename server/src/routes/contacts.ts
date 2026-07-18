import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { contacts } from "@defs";

import { getRequestActor, logEvent } from "../lib/activity";
import { ApiError, withErrorHandling } from "../lib/errors";
import { nowIso } from "../lib/files";
import { normalizePath } from "../lib/paths";
import { parseListPagination } from "../lib/pagination";
import { hasScope } from "../lib/mcp-scopes";
import { assertRestPathAllowed, getRestAuth, requireSessionAuth } from "../lib/rest-scopes";
import { getContactByName, sendFileToContact, toContactObject } from "../lib/peering";
import { validateWebhookUrlForDelivery } from "../lib/webhooks";
import type { AppEnv } from "../types";

export const contactsRoutes = new Hono<AppEnv>();

const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,31}$/u;

function normalizeContactName(input: unknown, fallback: string): string {
  const raw = typeof input === "string" && input.trim() ? input.trim().toLowerCase() : fallback;
  if (!NAME_PATTERN.test(raw)) {
    throw new ApiError(400, "validation_error", "name must be 1-32 chars of a-z 0-9 - _ (starting alphanumeric)");
  }
  return raw;
}

// Adding/removing a trusted peer is an ownership decision: session-only,
// same rationale as token minting.
contactsRoutes.post(
  "/",
  withErrorHandling(async (c) => {
    requireSessionAuth(c);
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown; name?: unknown; autoRelease?: unknown };
    if (typeof body.url !== "string" || !body.url.trim()) throw new ApiError(400, "validation_error", "url is required");
    const url = body.url.trim().replace(/\/+$/u, "");

    const unsafe = await validateWebhookUrlForDelivery(url);
    if (unsafe) throw new ApiError(400, "validation_error", `Peer URL rejected: ${unsafe}`);

    const cardResponse = await fetch(`${url}/api/public/.well-known/agent.json`, { redirect: "manual" });
    if (!cardResponse.ok) throw new ApiError(400, "peer_unreachable", `Peer Agent Card not reachable (HTTP ${cardResponse.status})`);
    const card = (await cardResponse.json().catch(() => null)) as { name?: unknown; signing?: { algorithm?: unknown; publicKeyJwk?: unknown } } | null;
    const publicKeyJwk = card?.signing?.publicKeyJwk as { kty?: unknown; crv?: unknown; x?: unknown; d?: unknown } | undefined;
    if (!publicKeyJwk || typeof publicKeyJwk !== "object") {
      throw new ApiError(400, "peer_invalid", "Peer Agent Card has no signing.publicKeyJwk");
    }
    const declaredAlgorithm = card?.signing?.algorithm;
    if (declaredAlgorithm !== undefined && declaredAlgorithm !== "Ed25519") {
      throw new ApiError(400, "peer_invalid", "Only Ed25519 peer keys are supported");
    }
    if (publicKeyJwk.kty !== "OKP" || publicKeyJwk.crv !== "Ed25519" || typeof publicKeyJwk.x !== "string" || publicKeyJwk.d !== undefined) {
      throw new ApiError(400, "peer_invalid", "Peer key must be a public OKP/Ed25519 JWK");
    }

    const fallbackName = new URL(url).hostname.split(".")[0].toLowerCase().replace(/[^a-z0-9-_]/gu, "-");
    const name = normalizeContactName(body.name, fallbackName);
    const autoRelease = body.autoRelease === true ? 1 : 0;

    const { db } = await import("edgespark");
    let created: typeof contacts.$inferSelect;
    try {
      [created] = await db
        .insert(contacts)
        .values({
          id: nanoid(),
          name,
          url,
          publicKeyJwk: JSON.stringify(publicKeyJwk),
          algorithm: "Ed25519",
          autoRelease,
          addedAt: nowIso(),
          ownerId: c.get("ownerId") ?? null,
        })
        .returning();
    } catch (error) {
      const message = (error as { message?: string } | null)?.message?.toLowerCase() ?? "";
      if (message.includes("unique constraint failed")) {
        throw new ApiError(409, "contact_exists", "A contact with this name or URL already exists");
      }
      throw error;
    }

    await logEvent(db, {
      ownerId: c.get("ownerId") ?? null,
      eventType: "contact.added",
      targetType: "share",
      targetId: created.id,
      actor: await getRequestActor(),
      metadata: { name: created.name, url: created.url, autoRelease: created.autoRelease === 1 },
    });
    return c.json({ contact: toContactObject(created) }, 201);
  })
);

contactsRoutes.get(
  "/",
  withErrorHandling(async (c) => {
    requireSessionAuth(c);
    const { limit, offset } = parseListPagination((name) => c.req.query(name), { defaultLimit: 100, maxLimit: 500 });
    const ownerId = c.get("ownerId") ?? null;
    const { db } = await import("edgespark");
    const rows = await db
      .select()
      .from(contacts)
      .where(ownerId ? eq(contacts.ownerId, ownerId) : undefined)
      .orderBy(desc(contacts.addedAt))
      .limit(limit)
      .offset(offset);
    return c.json({ contacts: rows.map(toContactObject), limit, offset });
  })
);

contactsRoutes.patch(
  "/:name",
  withErrorHandling(async (c) => {
    requireSessionAuth(c);
    const ownerId = c.get("ownerId") ?? null;
    const body = (await c.req.json().catch(() => ({}))) as { autoRelease?: unknown };
    if (typeof body.autoRelease !== "boolean") throw new ApiError(400, "validation_error", "autoRelease boolean required");
    const { db } = await import("edgespark");
    const [updated] = await db
      .update(contacts)
      .set({ autoRelease: body.autoRelease ? 1 : 0 })
      .where(and(eq(contacts.name, c.req.param("name") ?? ""), ownerId ? eq(contacts.ownerId, ownerId) : undefined))
      .returning();
    if (!updated) throw new ApiError(404, "contact_not_found", "Contact not found");
    return c.json({ contact: toContactObject(updated) });
  })
);

contactsRoutes.delete(
  "/:name",
  withErrorHandling(async (c) => {
    requireSessionAuth(c);
    const ownerId = c.get("ownerId") ?? null;
    const { db } = await import("edgespark");
    const deleted = await db
      .delete(contacts)
      .where(and(eq(contacts.name, c.req.param("name") ?? ""), ownerId ? eq(contacts.ownerId, ownerId) : undefined))
      .returning();
    if (deleted.length === 0) throw new ApiError(404, "contact_not_found", "Contact not found");
    await logEvent(db, {
      ownerId: c.get("ownerId") ?? null,
      eventType: "contact.removed",
      targetType: "share",
      targetId: deleted[0].id,
      actor: await getRequestActor(),
      metadata: { name: deleted[0].name, url: deleted[0].url },
    });
    return c.json({ removed: toContactObject(deleted[0]) });
  })
);

// Sending is an agent action (bearer allowed). Sending transmits file bytes
// to an external party — share semantics: require share:create (parity with
// the MCP send_file tool) plus a path check on the source file.
contactsRoutes.post(
  "/:name/send",
  withErrorHandling(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; message?: unknown };
    if (typeof body.path !== "string" || !body.path.trim()) throw new ApiError(400, "validation_error", "path is required");
    const filePath = normalizePath(body.path);
    const restAuth = getRestAuth(c);
    if (restAuth.kind === "bearer" && !hasScope(restAuth.scopes, "share:create")) {
      throw new ApiError(403, "invalid_scope", "invalid_scope:share:create");
    }
    assertRestPathAllowed(c, filePath);
    const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : null;

    const { db, storage } = await import("edgespark");
    const contact = await getContactByName(db, c.req.param("name") ?? "", c.get("ownerId") ?? null);
    if (!contact) throw new ApiError(404, "contact_not_found", "Contact not found");

    const origin = new URL(c.req.url).origin;
    try {
      const result = await sendFileToContact(db, storage, contact, filePath, message, origin);
      await logEvent(db, {
        ownerId: c.get("ownerId") ?? null,
        eventType: "file.sent",
        targetType: "file",
        targetPath: filePath,
        actor: await getRequestActor(),
        metadata: { contact: contact.name, url: contact.url, message },
      });
      return c.json(result);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (messageText.startsWith("file_not_found")) throw new ApiError(404, "file_not_found", "File not found");
      if (messageText.startsWith("file_too_large")) throw new ApiError(413, "file_too_large", messageText);
      if (messageText.startsWith("peer_unreachable") || messageText.startsWith("peer_rejected")) {
        throw new ApiError(502, "peer_error", messageText);
      }
      throw error;
    }
  })
);
