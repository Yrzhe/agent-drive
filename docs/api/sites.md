# ChatGPT Sites API contract

See [the Sites protocol and transfer reference](../../skill/references/sites.md) for native OAuth, MCP 2.0 metadata, multipart request sequences, CLI service access and private sharing limits.

`GET /api/public/session` returns `{ user: { id, email, name, image } | null, platform: "sites" }` with `Cache-Control: private, no-store`. Identity is supplied by the trusted Sites dispatcher, never by a browser-submitted email or application bearer token. Internal IDs derive from the stable Site-scoped subject, and email is a display/admin-configuration field.

`POST /mcp` uses native Sites authentication followed by Agent Drive approval and data authorization for tool calls. `initialize`, `server/discover` and `tools/list` expose only public instructions/schemas before OAuth or approval; they never return drive contents or grant access. The Site audience policy still applies. A private service caller can use the legacy `/api/public/mcp` with an application bearer plus platform service access. Browser and bearer REST endpoints, error codes and scopes are unchanged. Native MCP data calls from pending/suspended accounts return HTTP 403; legacy clients retain their existing JSON-RPC error behavior.

`GET|HEAD /api/public/transfer?token=...` streams the single granted R2 object. `PUT|POST` on an upload grant enforces the stored session, pending-file state, owner access status, exact byte counts and bounded chunk size. Invalid/expired/tampered grants return 401; replay/overlap return 409; oversized single uploads return 413. This path adds no general bucket-listing or arbitrary-object write API.

Sites application defaults are 625 GiB/file and 1 TiB total. Uploads stream using dynamic 8–64 MiB parts and at most 10,000 parts; use the returned part size. This transport cannot support files beyond 625 GiB even if the application quota is raised. Sites platform plan entitlements remain unconfirmed; Cloudflare's standalone R2 bucket capacity is a separate limit.

`MCP_ALLOWED_ORIGINS` is an optional comma-separated exact origin allowlist in addition to the configured Site origin. Unexpected browser Origins return 403. Modern protocol/header mismatches return HTTP 400 with JSON-RPC -32020; unsupported versions return -32022. Native Sites requests can omit `Mcp-Method`, `Mcp-Name` and namespaced protocol/capabilities metadata because hosting/client implementations may not forward them. Every supplied value is validated; this compatibility does not supply user identity or bypass data authorization. The application-bearer endpoint retains strict modern metadata/header checks. Classic `initialize` negotiates a supported 2025/2024 version even if the transport header is modern; `server/discover` serves MCP 2.0. `tools/list` includes read-only/destructive/idempotent/open-world hints and private 60-second cache metadata for modern clients. If an existing chat has no tools after a server update, refresh the plugin's tools and start a new chat.

MCP Events callbacks are not implemented or advertised. Existing Agent Drive webhooks keep their prior HMAC payload and delivery rules and are not interoperable with MCP Events subscriptions.

## Large-file MCP uploads

`prepare_file_upload {path}` without size returns a login-protected browser upload link for the same account; it creates no pending file. The user chooses the actual local file, including a 500 MB program or ZIP, and exact sizing, streaming multipart and confirmation run automatically. For byte-access automation, supply exact size and optional content_type for the regular transfer ticket, then call `complete_file_upload {file_id}`. Both tools require write:drive and enforce ownership/path scope through the same REST upload services. A private Site still enforces platform access on transfer URLs. Inline write_file text is capped at 5 MiB per tool message; that is independent of large-file storage uploads.

## File versions and stable shares (Sites)

Completed files keep immutable R2 objects. MCP `write_file` overwrites retain prior contents and use an atomic D1 compare-and-swap; history consumes quota. `GET /api/public/v1/files/:id/versions?limit=50&offset=0` returns history with `current`, without object keys; max page size is 100. History is owner-only, and bearer read/write and path scopes apply.

- `GET /api/public/v1/files/:id/versions/:versionId/download` returns a short-lived download URL.
- `POST /api/public/v1/files/:id/versions/:versionId/restore` switches the current pointer without deleting intervening versions.
- `POST /api/public/v1/files/:id/versions/upload` with `{size,contentType}` returns the regular transfer ticket plus `sessionId`; use the same streaming/multipart sequence.
- `POST /api/public/v1/files/:id/versions/complete` with `{sessionId}` verifies the bytes and switches the pointer only if the file has not changed since the ticket was created. HTTP 409 `version_conflict` preserves the intervening edit. Reload before uploading again.

`POST /api/public/v1/shares` accepts `shareMode: "latest" | "fixed"` (default latest), and an optional `versionId` for fixed single-file shares. MCP `create_share` accepts `share_mode` and `version_id`. Fixed folder shares are rejected. Password, expiry, download limits and Site audience checks still apply. Fixed links retain their selected bytes; latest links resolve current bytes on open/download. Already-open pages do not yet receive cross-instance push updates, and an already-issued download grant continues to refer to its granted object until expiry.

Purging a file makes its history and shares unavailable. Bounded background cleanup retries removal of retained R2 objects and orphaned metadata. This cleanup is opportunistic, not a guaranteed scheduled job.
