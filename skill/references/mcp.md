# MCP (Remote Model Context Protocol)

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

## Tools (10) → required scope

| Tool | Scope | Notes |
|---|---|---|
| `list_files`, `read_file`, `search_files` | `read:drive` | `read_file` returns file **text directly** (no share needed), UTF-8 up to 5 MB — larger/binary via REST download |
| `write_file` | `write:drive` | **UTF-8 text only, max 5 MB.** Binary/large files → REST presigned flow, not `write_file` |
| `create_share` | `share:create` | Returns `{ shareUrl, guideUrl }` — put `guideUrl` in hand-off messages |
| `send_file` | `share:create` | Drive-to-Drive delivery to a pinned contact (see `peering.md`) |
| `remember`, `recall`, `list_memories`, `forget` | `read:memory` / `write:memory` | Cross-session memory (see `memory.md`) |

On `initialize`, the server returns rich `instructions` (granted scopes, path rules, text-vs-binary, error codes) — read them.

## Binary / large uploads (write_file can't do these)

`write_file` is text-only. For PDFs, images, video, or files > 5 MB use REST:

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
