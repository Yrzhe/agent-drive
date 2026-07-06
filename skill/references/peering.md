# Peering — Drive-to-Drive exchange

Send files directly to another Agent Drive without a human copy-pasting share links, and subscribe to bundles another Drive published. All cross-Drive traffic is Ed25519-signed and verified against each deployment's Agent Card.

## Trust model

- The **owner** adds a peer as a contact (session-only, `/connect` API or REST): the server SSRF-validates the peer URL, fetches its `/.well-known/agent.json`, and pins the peer's public key.
- Inbound deliveries are accepted **only from pinned contacts** with a valid signature over the exact request body, and a `sentAt` within ±5 minutes.
- Files from contacts land in **quarantine** (`/inbox/pending/<contact>/`) unless the owner marked the contact `autoRelease` — external content is untrusted by default. Review, then move files out with normal file operations.

## Sending a file (agent action)

MCP tool:

```
send_file { contact: "bob", path: "/reports/q2.pdf", message: "Q2 numbers as promised" }
```

REST equivalent: `POST /api/public/v1/contacts/bob/send` body `{ path, message? }`.

- Requires `share:create` scope + path scope covering the source file.
- Max 5 MB per file (peer inbox limit). Larger content: create a share link instead.
- Errors: `contact_not_found`, `file_too_large` (413), `peer_error` (502 — peer down or rejected).

## Receiving

Nothing to do per delivery: peers POST to `/api/public/inbox`, quarantined files appear under `/inbox/pending/<contact>/`, an `inbox.received` activity event is logged, and webhooks fire (subscribe a webhook to get notified). Tell your owner to check quarantine or mark you-trusted contacts `autoRelease`.

## Contact management (OWNER action — human handoff)

Ask the owner to run these while logged in in a browser session (agents' bearer tokens are rejected by design):

```
POST /api/public/v1/contacts        { "url": "https://their-drive.example.com", "name": "bob", "autoRelease": false }
GET  /api/public/v1/contacts
PATCH /api/public/v1/contacts/bob   { "autoRelease": true }
DELETE /api/public/v1/contacts/bob
```

Both Drives must add each other to exchange in both directions.

## Subscribing to published bundles

A Drive can publish a bundle prefix for anonymous subscription:

```
POST /api/public/v1/bundles/publish   { "prefix": "/skills/my-skill", "public": true }
→ { publicId, subscribeUrl }
```

Anyone (no account) can then pull it, with the manifest signature verified against the publisher's Agent Card:

```
adrive subscribe https://their-drive.example.com/api/public/b/pb_xxx/current --to ./local-dir
```

Re-run the same command to pull updates. `--no-verify` skips signature verification (not recommended). Unpublish with `{ "public": false }` — the publicId is invalidated immediately.
