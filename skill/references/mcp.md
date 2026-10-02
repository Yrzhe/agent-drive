# MCP (Remote Model Context Protocol)

Sites deployments also expose native `/mcp` with Sites-managed OAuth and MCP 2.0 (`2026-07-28`). See [Sites reference](./sites.md) for metadata-only discovery, Sites transport compatibility, multipart uploads, and private access limits. Native discovery can precede OAuth; data calls still require authenticated, active access. The legacy endpoint and examples below remain available for application-bearer clients. MCP Events is not advertised.

Agent Drive exposes a remote MCP endpoint so IDE/agent clients get the drive as native tools — no manual REST calls.

```
POST {url}/api/public/mcp        (JSON-RPC 2.0)
```

`{url}` is your deployment origin (in `drive.json`).

## Which auth path? (decision)

| You are… | Use | How |
|---|---|---|
| An IDE / third-party MCP client (Claude Desktop, Cursor, Codex, Gemini, Windsurf) | **OAuth** (dynamic client registration + PKCE) — scoped & revocable | Owner opens **`{url}/connect`** → pick scopes → copy the per-IDE config snippet. See `docs/setup/mcp-<client>.md`. |
| Your own self-hosted agent / a script | **`AGENT_TOKEN`** bearer bypass | Send `Authorization: Bearer {AGENT_TOKEN}` (from `.env`). Full default scopes; narrow with the `AGENT_TOKEN_SCOPES` var. |

Both land on the same scope-checked tool surface. Never put the `AGENT_TOKEN` in a hand-off message — it is the owner's private key.

## Tools (16) → required scope

| Tool | Scope | Notes |
|---|---|---|
| `list_files`, `read_file`, `search_files` | `read:drive` | `read_file` returns file **text directly** (no share needed), UTF-8 up to 5 MB — larger/binary via REST download |
| `write_file` | `write:drive` | Inline UTF-8 text only, max 5 MiB. Large/binary files use `prepare_file_upload` |
| `prepare_file_upload`, `complete_file_upload` | `write:drive` | Browser upload links or streaming transfer tickets and confirmation for large/binary files |
| `create_share` | `share:create` | Returns `{ shareUrl, guideUrl }` — put `guideUrl` in hand-off messages |
| `send_file` | `share:create` | Drive-to-Drive delivery to a pinned contact (see `peering.md`) |
| `remember`, `recall`, `list_memories`, `forget` | `read:memory` / `write:memory` | Cross-session memory (see `memory.md`) |
| `list_spaces`, `read_space` | `read:drive` | Discover/read Shared Spaces you belong to (see `spaces.md`) |
| `add_to_space`, `remove_from_space`, `create_space`, `manage_space_members` | `write:drive` | Share your own resources by reference; no new scope (see `spaces.md`) |

On `initialize`, the server returns rich `instructions` (granted scopes, path rules, text-vs-binary, error codes) — read them.

## Binary / large uploads (write_file can't do these)

`write_file` is inline text-only (5 MiB per message), not a storage-size limit.

- For a user's local file, call `prepare_file_upload {path:"/program.zip"}` **without size**. It returns `uploadPageUrl`; give this link to the user. The authenticated browser selects the actual file, reads its exact byte count and automatically uploads bounded chunks and confirms completion. No pending file or upload credential is created by this link-only call. The link names the intended account; sign in as that account. A 500 MB program or ZIP uses this flow.
- For a client that has the bytes and their exact count, call `prepare_file_upload {path,size,content_type?}`. The response includes `fileId`, `uploadUrl`, `requiredHeaders`, `expiresAt` and optional `multipart.partSize`. Small files use PUT; large files use POST `{action:"start"}`, sequential PUT `part=1..N`, POST `{action:"complete"}`. Finish with `complete_file_upload {file_id:fileId}`. Read-only/path-scoped tokens remain restricted, and another owner cannot complete your ticket.
- Sites defaults are 625 GiB/file and 1 TiB total application quota, not confirmed platform entitlements. Private Site platform access still applies to HTTP transfer URLs; MCP OAuth does not give a separate HTTP client a browser session or service credential. The browser upload flow needs no service credential.

The corresponding REST flow remains available:

```
POST {url}/api/public/v1/files/upload   → { uploadUrl, ... }
PUT  {uploadUrl}  (the raw bytes)
POST {url}/api/public/v1/files/upload/complete
```

See `file-ops.md`.

## Rules & errors

- Paths are absolute, must start with `/`.
- A path-scoped token only reaches its granted prefix; out-of-scope calls return `-32001 invalid_scope:path:<path>`.
- JSON-RPC error codes: `-32001` scope, `-32602` bad params, `-32000` app errors (`file_too_large`, `quota_exceeded`, `path_conflict`, `file_not_found`, …). `error.message` is a colon-delimited code.

Full JSON-RPC contract: `docs/api/mcp.md`. OAuth details: `docs/api/oauth.md`.
