# Webhooks API

Register HTTP callbacks that fire when drive events happen (uploads, shares, trash, peering, memory, …). Deliveries are signed with the webhook's secret so the receiver can verify authenticity.

Base: `<YOUR_AGENT_DRIVE_URL>/api/public/v1/webhooks`

## Auth & scope

Standard bearer/session auth. Because webhook deliveries carry events for the **whole drive**, these endpoints require **root path access** — a path-restricted token (e.g. `path:/handoffs/*`) is rejected with `403 invalid_scope:path:/`. Capability scopes: `read:drive` to list, `write:drive` to create/delete/test.

## Endpoints

### Create — `POST /v1/webhooks`

```json
{
  "url": "https://example.com/hook",
  "eventTypes": ["file.uploaded", "share.created"],
  "secret": "optional-hmac-secret"
}
```

- `url` (required) — HTTPS endpoint. **SSRF-validated** at creation (private/loopback/link-local hosts are rejected).
- `eventTypes` (required) — non-empty array of event names to subscribe to.
- `secret` (optional) — HMAC signing secret; if omitted, one is generated and returned **once**.

Returns `201`:

```json
{
  "webhook": { "id": "...", "url": "...", "eventTypes": [...], "enabled": true,
               "lastTriggeredAt": null, "lastStatus": null, "failureCount": 0,
               "createdAt": "...", "secret": "..." },
  "hint": "This secret is shown once. Save it now."
}
```

### List — `GET /v1/webhooks?limit=&offset=`

Paginated (`limit` default 100, max 500; `offset` default 0). The `secret` is **not** returned here.

```json
{ "webhooks": [ { "id": "...", "url": "...", "eventTypes": [...], "enabled": true,
                  "lastTriggeredAt": "...", "lastStatus": 200, "failureCount": 0, "createdAt": "..." } ],
  "limit": 100, "offset": 0 }
```

### Delete — `DELETE /v1/webhooks/:id`

Returns `{ "success": true }`, or `404 webhook_not_found`.

### Test — `POST /v1/webhooks/:id/test`

Fires a `webhook.test` delivery to the registered URL in the background. Returns `{ "success": true }` (delivery result is reflected later in `lastStatus`/`failureCount` via `GET`), or `404 webhook_not_found`.

## Delivery format

Each delivery is `POST`ed to the registered `url` with headers:

- `Content-Type: application/json`
- `X-Agent-Drive-Event: <eventType>`
- `X-Signature: sha256=<hex>` — HMAC-SHA256 of the raw request body, keyed by the webhook secret. Verify this to authenticate the delivery.

Body:

```json
{ "event": "<eventType>", "timestamp": "<ISO-8601>", "data": { "...": "event-specific" } }
```

The target URL is re-validated at delivery time and `redirect: "manual"` blocks redirect-based SSRF (a DNS-rebinding window is documented in code). Delivery is best-effort/background; the result is reflected in `lastStatus` / `failureCount` (via `GET`).

- **Retry**: a `5xx` response triggers exactly one retry, after a 2-second delay. Network errors, timeouts, and non-5xx failures are not retried.
- **Auto-disable**: `failureCount` increments on any failed delivery (after the retry, if one happened) and resets to 0 on success. After 5 consecutive failures, the webhook is automatically disabled (`enabled: false`) — re-enable it manually (delete and recreate, since there is no separate enable endpoint) once the target is fixed.

## Errors

`400 validation_error` (missing `url`, empty or non-array `eventTypes`, or an SSRF-rejected URL), `403 invalid_scope` (message `invalid_scope:path:/` — a path-restricted token), `404 webhook_not_found`.
