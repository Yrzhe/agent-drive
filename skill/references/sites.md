# ChatGPT Sites deployment

Read this before using a Sites-hosted Agent Drive. Application-public endpoints remain behind the Site's audience policy.

## Native Remote MCP

Connect ChatGPT Developer Mode to `https://<site-host>/mcp`, using Sites-managed OAuth. Sign in with ChatGPT; an approved account operates its own drive and authorized Shared Spaces. New accounts remain pending until the administrator approves them. Native OAuth is separate from the legacy application OAuth at `/api/public/oauth/*`.

Supported MCP versions: `2026-07-28` (2.0), `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. Modern requests use `server/discover` and per-request `_meta` keys `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`, plus matching `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers when applicable. No session ID or GET SSE stream is issued. The same 16 tools are exposed, filtered by scopes for application bearer callers. MCP Events is not advertised.

## CLI and application REST

Keep the existing `/api/public/mcp` endpoint for `adrive`. Mint a scoped application token in the Connect screen. Private Sites also needs a platform service credential in `OAI-Sites-Authorization`; this does not replace the application token or supply a user identity. The CLI reads it from `ADRIVE_SITES_AUTHORIZATION` only for the origin in `ADRIVE_SITES_URL`, refuses authenticated redirects, and never saves it in its config. Set these through a secure environment, never paste credentials into chat or source.

Native `/mcp` account permissions follow the approved signed-in account. CLI/app bearer scopes and path prefixes remain independently enforced.

## R2 uploads and downloads

Request `POST /api/public/v1/files/upload` as before. If the ticket includes `multipart.partSize` (8 MiB), upload files above that size as follows:

1. `POST uploadUrl` with JSON `{ "action": "start" }`.
2. Sequential `PUT uploadUrl&part=N` requests, numbered from 1. Each body is exactly `partSize` bytes, except the final remainder. Retry a failed part; overlapping operations return 409.
3. `POST uploadUrl` with JSON `{ "action": "complete" }`. Use `{ "action": "abort" }` if abandoning the session.
4. Call the existing `POST /api/public/v1/files/upload/complete` to confirm metadata.

Small files use one PUT. Grants expire after an hour and cannot overwrite a completed upload. Required content type comes from the ticket; the server validates exact byte counts. The browser handles multipart automatically. Returned same-origin download URLs support streaming, HEAD and byte ranges; treat them as short-lived secrets.

## Access limits

A private Site requires platform access even for application-public shares, published bundle subscriptions, signed inbox delivery and downloads. Existing handlers are retained; anonymous external recipients do not automatically gain access. Cross-Drive sending to a private target needs an access arrangement outside the sender's existing signed inbox protocol. Never claim that making an application share bypasses Sites privacy. Do not publish the whole Site to change this without the owner's instruction.

This is a fresh Sites deployment. Existing EdgeSpark records and object bytes are not automatically copied; data transfer needs an explicit export/import and a verified old-user-to-new-Sites-subject mapping. Never merge accounts by email alone or copy EdgeSpark authentication tables into Sites.
