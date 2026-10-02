# ChatGPT Sites deployment

Read this before using a Sites-hosted Agent Drive. Application-public endpoints remain behind the Site's audience policy.

## Native Remote MCP

Connect ChatGPT Developer Mode to `https://<site-host>/mcp`, using Sites-managed OAuth. Sign in with ChatGPT; an approved account operates its own drive and authorized Shared Spaces. New accounts remain pending until the administrator approves them. Native OAuth is separate from the legacy application OAuth at `/api/public/oauth/*`.

Supported MCP versions: `2026-07-28` (2.0), `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. Modern requests use `server/discover` and per-request `_meta` keys `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`, plus matching `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers when applicable. Native Sites accepts omitted method/name headers and protocol/capabilities metadata for hosting/client compatibility; every supplied value is validated. The application-bearer endpoint retains strict modern validation. Classic `initialize` negotiates a supported 2025/2024 version even with a modern transport header. No session ID or GET SSE stream is issued. The same 18 tools are exposed, filtered by scopes for application bearer callers. MCP Events is not advertised.

Native `initialize`, `server/discover` and `tools/list` are metadata-only and available before user OAuth or app approval, within the Site audience. They expose no files, memory, account identity or granted user access. `tools/call` still requires authentication and an active account. A private service credential does not create a user identity. After an update, refresh the plugin's tool metadata and start a new chat if the old chat has no actions.

## CLI and application REST

Keep the existing `/api/public/mcp` endpoint for `adrive`. Mint a scoped application token in the Connect screen. Private Sites also needs a platform service credential in `OAI-Sites-Authorization`; this does not replace the application token or supply a user identity. The CLI reads it from `ADRIVE_SITES_AUTHORIZATION` only for the origin in `ADRIVE_SITES_URL`, refuses authenticated redirects, and never saves it in its config. Set these through a secure environment, never paste credentials into chat or source.

Native `/mcp` account permissions follow the approved signed-in account. CLI/app bearer scopes and path prefixes remain independently enforced.

## R2 uploads and downloads

For local programs/ZIPs including 500 MB files, call MCP `prepare_file_upload {path}` without size and give its authenticated `uploadPageUrl` to the user. The browser detects exact bytes, streams bounded chunks and completes automatically. A byte-access client can instead supply exact size and use the returned transfer ticket, then call `complete_file_upload {file_id}`. The inline 5 MiB `write_file` text cap does not limit these uploads.

Request `POST /api/public/v1/files/upload` as before. Sites defaults to 625 GiB per file and 1 TiB total application quota, with streamed uploads. Use the ticket's `multipart.partSize` (dynamic 8–64 MiB), never a hardcoded chunk size. Upload files above that size as follows:

1. `POST uploadUrl` with JSON `{ "action": "start" }`.
2. Sequential `PUT uploadUrl&part=N` requests, numbered from 1. Each body is exactly `partSize` bytes, except the final remainder. Retry a failed part; overlapping operations return 409.
3. `POST uploadUrl` with JSON `{ "action": "complete" }`. Use `{ "action": "abort" }` if abandoning the session.
4. Call the existing `POST /api/public/v1/files/upload/complete` to confirm metadata.

Small files use one PUT. Upload expiration comes from the ticket: at least an hour, extended by declared size for large transfers (budgeted at 5 MiB/s plus 15 minutes, capped at seven days). Grants cannot overwrite a completed upload. Required content type comes from the ticket; the server validates exact byte counts. The browser handles multipart automatically. Returned same-origin download URLs support streaming, HEAD and byte ranges; treat them as short-lived secrets.

## File history and share versions

Sites `write_file` retains old immutable bytes. List owner-only history with `GET /api/public/v1/files/:id/versions?limit=50&offset=0` (max limit 100). Download via `GET /:id/versions/:versionId/download`; restore via `POST /:id/versions/:versionId/restore`. For large/binary replacements, `POST /:id/versions/upload` with `{size,contentType}`, upload using its ticket, then `POST /:id/versions/complete` with `{sessionId}`. A concurrent edit yields HTTP 409 `version_conflict`; reload the file before retrying. Read/write scopes and path grants apply, and history counts toward quota.

MCP `create_share` accepts `share_mode: "latest"` (default) or `"fixed"`; optional `version_id` selects a retained history version for a fixed file share. REST uses `shareMode`/`versionId`. Latest links follow the current file at open/download; fixed links retain their selected contents. Folder shares follow current contents. Existing password, expiry, counts and private Site access remain in force. Already-open pages do not receive live push yet; MCP Events is also not implemented. A short-lived download URL already issued for A keeps granting A until it expires, even after the latest share starts resolving B.

Purging a file removes access to its history and shares. Retained R2 objects and orphan metadata are removed by bounded, retryable background cleanup.

## Access limits

A private Site requires platform access even for application-public shares, published bundle subscriptions, signed inbox delivery and downloads. Existing handlers are retained; anonymous external recipients do not automatically gain access. Cross-Drive sending to a private target needs an access arrangement outside the sender's existing signed inbox protocol. Never claim that making an application share bypasses Sites privacy. Do not publish the whole Site to change this without the owner's instruction.

This is a fresh Sites deployment. Existing EdgeSpark records and object bytes are not automatically copied; data transfer needs an explicit export/import and a verified old-user-to-new-Sites-subject mapping. Never merge accounts by email alone or copy EdgeSpark authentication tables into Sites.
