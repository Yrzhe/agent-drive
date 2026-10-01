# ChatGPT Sites API contract

See [the Sites protocol and transfer reference](../../skill/references/sites.md) for native OAuth, MCP 2.0 metadata, multipart request sequences, CLI service access and private sharing limits.

`GET /api/public/session` returns `{ user: { id, email, name, image } | null, platform: "sites" }` with `Cache-Control: private, no-store`. Identity is supplied by the trusted Sites dispatcher, never by a browser-submitted email or application bearer token. Internal IDs derive from the stable Site-scoped subject, and email is a display/admin-configuration field.

`POST /mcp` uses native Sites authentication followed by Agent Drive approval and data authorization. A private service caller can use the legacy `/api/public/mcp` with an application bearer plus platform service access. Browser and bearer REST endpoints, error codes and scopes are unchanged. Native MCP pending/suspended requests return HTTP 403; legacy clients retain their existing JSON-RPC error behavior.

`GET|HEAD /api/public/transfer?token=...` streams the single granted R2 object. `PUT|POST` on an upload grant enforces the stored session, pending-file state, owner access status, exact byte counts and bounded chunk size. Invalid/expired/tampered grants return 401; replay/overlap return 409; oversized single uploads return 413. This path adds no general bucket-listing or arbitrary-object write API.

`MCP_ALLOWED_ORIGINS` is an optional comma-separated exact origin allowlist in addition to the configured Site origin. Unexpected browser Origins return 403. Modern protocol/header mismatches return HTTP 400 with JSON-RPC -32020; unsupported versions return -32022. `tools/list` includes read-only/destructive/idempotent/open-world hints and private 60-second cache metadata for modern clients.

MCP Events callbacks are not implemented or advertised. Existing Agent Drive webhooks keep their prior HMAC payload and delivery rules and are not interoperable with MCP Events subscriptions.
