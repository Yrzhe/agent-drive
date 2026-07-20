# Agent Card

`GET /api/public/.well-known/agent.json` (alias: `agent-card.json`) — public, no auth, cacheable for 5 minutes.

An [A2A-compatible](https://a2a-protocol.org/) Agent Card describing this deployment: identity, capabilities, and machine endpoints. It is the first step toward Drive-to-Drive peering (roadmap 4.1): peers fetch the card once and can later verify signed requests and bundle manifests against the published key.

> **Known deviation from A2A discovery**: the A2A spec places the card at the site root (`/.well-known/agent.json`), but EdgeSpark only routes `/api/*` through the server, so the canonical URL here is `/api/public/.well-known/agent.json`. The card itself advertises this via `x-agent-drive.cardUrl`, and `/llms.txt` points agents at the right place.

## Identity keypair

- Generated **on first request** server-side: Ed25519 via WebCrypto.
- The private key is stored in D1 (`agent_identity` table, single `self` row) and never leaves the server; only the public JWK appears in the card.
- Concurrent first requests are safe — the primary-key race loser serves the winner's key.
- The card is stable across requests; a changed key means the row was deleted deliberately.

## Shape (abridged)

```json
{
  "protocolVersion": "1.0",
  "name": "Agent Drive @ your-host.edgespark.app",
  "url": "https://your-host.edgespark.app",
  "version": "1.2",
  "capabilities": { "streaming": false, "pushNotifications": false },
  "skills": [
    { "id": "file-exchange", "name": "File exchange", "description": "..." },
    { "id": "memory", "name": "Persistent memory", "description": "..." },
    { "id": "bundles", "name": "Versioned bundles", "description": "..." },
    { "id": "spaces", "name": "Shared spaces", "description": "Share your own files, folders, and memory with other users by reference (no storage copy) via invite-only spaces plus one instance-wide public commons." }
  ],
  "securitySchemes": {
    "oauth2": { "type": "oauth2", "flows": { "authorizationCode": { "authorizationUrl": ".../oauth/authorize", "tokenUrl": ".../oauth/token", "scopes": { "read:drive": "..." } } } },
    "bearer": { "type": "http", "scheme": "bearer" }
  },
  "signing": {
    "algorithm": "Ed25519",
    "publicKeyJwk": { "kty": "OKP", "crv": "Ed25519", "x": "..." },
    "purpose": "Future peer handshakes and bundle signatures verify against this key."
  },
  "x-agent-drive": {
    "mcp": ".../api/public/mcp",
    "rest": ".../api/public/v1",
    "guide": ".../api/public/guide",
    "llmsTxt": ".../llms.txt",
    "inbox": ".../api/public/inbox",
    "inboxStatus": "live — POST a signed payload after the owner adds you as a contact"
  }
}
```

Drive-specific fields live under `x-agent-drive` so strict A2A clients can ignore them. The inbox went live with Drive peering (#13) — see [`peering.md`](./peering.md).

## Origin

The card's URLs honor the `ALLOWED_ORIGIN` var when set (same rule as OAuth discovery), so cards served behind a custom domain advertise that domain.
