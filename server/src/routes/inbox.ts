import { Hono } from "hono";

import { verifyWithJwk, type Jwk } from "../lib/agent-identity";
import { logEvent } from "../lib/activity";
import { ApiError, withErrorHandling } from "../lib/errors";
import {
  SIGNATURE_HEADER,
  decodeInboxContent,
  getContactByUrl,
  parseInboxPayload,
  storeInboxFile,
} from "../lib/peering";
import { triggerWebhooks } from "../lib/webhooks";

export const inboxRoutes = new Hono();

function payloadError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("invalid_payload:")) {
    throw new ApiError(400, "invalid_payload", message.slice("invalid_payload:".length));
  }
  throw error;
}

inboxRoutes.post(
  "/",
  withErrorHandling(async (c) => {
    const signature = c.req.header(SIGNATURE_HEADER);
    if (!signature) throw new ApiError(401, "signature_required", "X-Agent-Signature header is required");

    // Pre-auth guard: refuse to buffer bodies that cannot be a valid delivery
    // (5MB content -> ~6.9MB base64 + JSON envelope headroom).
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > 8 * 1024 * 1024) {
      throw new ApiError(413, "payload_too_large", "Inbox deliveries are limited to 5MB of content");
    }

    const rawBody = await c.req.text();
    let payload;
    try {
      payload = parseInboxPayload(JSON.parse(rawBody));
    } catch (error) {
      if (error instanceof SyntaxError) throw new ApiError(400, "invalid_payload", "Body must be JSON");
      payloadError(error);
    }

    const { db, storage, ctx } = await import("edgespark");
    const contact = await getContactByUrl(db, payload.from);
    if (!contact) {
      // Unknown sender: no detail leakage, fixed error. Peering requires the
      // owner to add the contact first.
      throw new ApiError(403, "unknown_sender", "Sender is not a contact of this Drive");
    }

    const verified = await verifyWithJwk(
      JSON.parse(contact.publicKeyJwk) as Jwk,
      new TextEncoder().encode(rawBody),
      signature
    );
    if (!verified) throw new ApiError(401, "invalid_signature", "Signature does not verify against the contact's key");

    let bytes: Uint8Array;
    try {
      bytes = decodeInboxContent(payload.contentBase64);
    } catch (error) {
      payloadError(error);
    }

    const { file, folder, quarantined } = await storeInboxFile(db, storage, contact, payload, bytes);

    await logEvent(db, {
      eventType: "inbox.received",
      targetType: "file",
      targetId: file.id,
      targetPath: file.path,
      actor: "agent",
      metadata: { from: contact.name, url: contact.url, message: payload.message, quarantined, size: file.size },
    });
    ctx.runInBackground(
      triggerWebhooks(db, {
        eventType: "inbox.received",
        data: { from: contact.name, path: file.path, size: file.size, message: payload.message, quarantined },
      })
    );

    return c.json({
      received: true,
      path: file.path,
      folder,
      quarantined,
      note: quarantined
        ? "File is in quarantine; the owner reviews /inbox/pending before release."
        : "Contact is trusted; file released directly to the inbox.",
    }, 201);
  })
);
