# Peering API — contacts, signed inbox, published bundles

Implements roadmap 4.1b/4.2 (#13) and 4.4 (#14): direct Drive-to-Drive exchange with the Moltbook-lesson defaults — external content is untrusted, quarantined, and every cross-Drive request is signed and verified against a pinned key.

## Contacts (session-only management)

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/api/public/v1/contacts` | `{ url, name?, autoRelease? }` | SSRF-validates `url` (same DoH policy as webhooks), fetches the peer's Agent Card, pins `signing.publicKeyJwk`. 409 on duplicate name/url. |
| GET | `/api/public/v1/contacts` | `?limit=100&offset=0` (max 500) | |
| PATCH | `/api/public/v1/contacts/:name` | `{ autoRelease }` | `autoRelease: true` skips quarantine for this contact |
| DELETE | `/api/public/v1/contacts/:name` | — | |

Adding a trusted peer is an ownership decision: bearer callers get `403 session_required` (same rationale as token minting). `name` is a local handle (`a-z0-9-_`, ≤32 chars).

## Sending: `POST /api/public/v1/contacts/:name/send`

Bearer allowed (`write:drive` capability via middleware + path scope on the source file). Body `{ path, message? }`. MCP equivalent: `send_file { contact, path, message? }` (scope `share:create`).

The server loads the file (≤5 MB), builds the inbox payload, signs the exact JSON bytes with this Drive's Ed25519 identity key, SSRF-validates the peer inbox URL, and POSTs with `X-Agent-Signature`. Activity event `file.sent`.

## Receiving: `POST /api/public/inbox` (public route)

Request: JSON body `{ from, filename, contentType?, contentBase64, message?, sentAt }` + header `X-Agent-Signature: <base64url Ed25519 over the raw body bytes>`.

Server-side checks, in order:

1. `from` must match a pinned contact URL — unknown senders get a fixed `403 unknown_sender` (no information leakage).
2. Signature must verify against the contact's pinned public key over the **raw body bytes**.
3. `sentAt` must be within ±5 minutes (replay window; a replay inside the window re-lands the same file in quarantine, which is visible and harmless).
4. Content ≤5 MB after base64 decode; filename normalized; name collisions get a timestamp suffix.

Accepted files land in `/inbox/pending/<contact>/` (or `/inbox/<contact>/` for `autoRelease` contacts), log `inbox.received`, and fan out to webhooks.

## Published bundles

| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| POST | `/api/public/v1/bundles/publish` | bearer/session (`write:drive` + path scope) | `{ prefix, public: true|false }` → `{ publicId, subscribeUrl }`. Re-publishing keeps the same `publicId`; unpublish nulls it immediately. |
| GET | `/api/public/b/:publicId/current` | none | Version metadata + Ed25519 signature over the exact manifest bytes |
| GET | `/api/public/b/:publicId/manifest` | none | The manifest bytes (what the signature signs) |
| GET | `/api/public/b/:publicId/file?path=` | none | Presigned download; **only manifest-listed relative paths** resolve — never arbitrary drive paths or `.history/` snapshots |

CLI: `adrive subscribe <subscribeUrl> --to <dir>` downloads everything and verifies the signature against the publisher's Agent Card (`--no-verify` to skip). Re-run to update.

## Error codes

| Status | Code | Meaning |
|---|---|---|
| 401 | `signature_required` / `invalid_signature` | Missing or non-verifying `X-Agent-Signature` |
| 403 | `unknown_sender` | `from` is not a pinned contact |
| 400 | `invalid_payload` | Shape/size/timestamp validation failed |
| 413 | `file_too_large` | Send: file exceeds the 5 MB inbox limit |
| 502 | `peer_error` | Send: peer unreachable, SSRF-blocked, or rejected the delivery |
| 404 | `bundle_not_found` | No published bundle with that publicId |
