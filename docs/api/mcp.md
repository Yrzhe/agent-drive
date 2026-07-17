# MCP Reference

The Agent Drive MCP endpoint speaks **Streamable HTTP JSON-RPC 2.0**. Server-Sent Events are not implemented. The endpoint is:

```text
POST <YOUR_AGENT_DRIVE_URL>/api/public/mcp
```

`<YOUR_AGENT_DRIVE_URL>` is your deployment origin — see [the setup guide](../setup/mcp-claude.md#finding-your-agent-drive-url).

### Transport methods

`POST` carries every JSON-RPC message. The other Streamable HTTP methods answer `405 Method Not Allowed` with an `Allow: POST` header:

| Method | Response | Why |
|---|---|---|
| `POST` | JSON-RPC 2.0 response | The only supported method. |
| `GET` | `405 method_not_allowed` | Would open an SSE stream; this server offers none. The spec requires `405` (not `404`) to signal that. |
| `DELETE` | `405 method_not_allowed` | Terminates a session; this server is stateless and issues no `Mcp-Session-Id`. |

A `404` from this endpoint means "session terminated — re-initialize" in MCP, so it is never used to signal an unsupported method.

## Authentication

Every request **must** include:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

`<token>` is one of:

1. An OAuth 2.1 access token obtained via the [OAuth flow](./oauth.md). Scope is whatever the user approved.
2. The `AGENT_TOKEN` EdgeSpark secret on the deployment. Bypass path for self-hosted single-user mode; defaults to `read:drive write:drive share:create read:memory write:memory path:/`.

Set the optional `AGENT_TOKEN_SCOPES` var to narrow the bypass token for MCP, for example:

```text
read:drive path:/handoffs/*
```

`AGENT_TOKEN_SCOPES` can only select from the default AGENT_TOKEN MCP capabilities (`read:drive`, `write:drive`, `share:create`, `read:memory`, `write:memory`) plus optional `path:/...` restrictions. If it is set but malformed or includes unsupported scopes, the AGENT_TOKEN exposes no MCP tools until the var is fixed.

### 401 + WWW-Authenticate

A request with no `Authorization` header returns:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="<YOUR_AGENT_DRIVE_URL>/api/public/.well-known/oauth-protected-resource"
```

per [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728). MCP clients use this to autodiscover the authorization server.

## Methods

Three JSON-RPC methods are implemented.

### `initialize`

Negotiates protocol version + advertises server identity.

Request:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "agent-drive", "version": "0.1.0" },
    "instructions": "Agent Drive MCP server. auth_mode: agent_token | oauth_bearer."
  }
}
```

### `tools/list`

Returns the tools available **for the current token's scope**. Tools whose required scope is not held are filtered out.

Request:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }
```

Response (with full drive scopes):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      { "name": "list_files", "description": "...", "inputSchema": { ... } },
      { "name": "read_file", ... },
      { "name": "write_file", ... },
      { "name": "search_files", ... },
      { "name": "create_share", ... },
      { "name": "send_file", ... },
      { "name": "remember", ... },
      { "name": "recall", ... },
      { "name": "list_memories", ... },
      { "name": "forget", ... }
    ]
  }
}
```

### `tools/call`

Invokes a single tool. Request shape:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "<tool_name>",
    "arguments": { ... }
  }
}
```

Response shape (success):

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [ { "type": "text", "text": "<JSON-stringified payload>" } ]
  }
}
```

The `content[0].text` payload is a JSON string. Clients should `JSON.parse` it.

## Tools

All tool input/output schemas are sourced from `server/src/lib/mcp-tools.ts`.

Memory tools (`remember`, `recall`, `list_memories`, `forget`) are documented in [`memory.md`](./memory.md); they follow the same JSON-RPC calling convention and require the `read:memory` / `write:memory` scopes.

### `list_files`

Required scope: `read:drive`

Lists files and folders at a path.

Input:

| Field | Type | Default | Notes |
|---|---|---|---|
| `path` | string | `/` | Folder path to list |
| `recursive` | boolean | `false` | List descendants |
| `limit` | number | `100` | 1–200 |
| `offset` | number | `0` | Number of visible entries to skip after scope filtering |

Output (`text` payload, parsed):

```json
{
  "path": "/",
  "limit": 100,
  "offset": 0,
  "files": [
    { "id": "...", "name": "...", "path": "...", "isFolder": 0|1, "size": 1234, "contentType": "text/plain", "createdAt": "...", "updatedAt": "..." }
  ]
}
```

### `read_file`

Required scope: `read:drive`

Reads a **UTF-8 text file** by absolute path, up to **5 MB**. For larger or binary files use the REST download (`GET /api/public/v1/files/:id/preview`).

Input:

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | Absolute file path |

Output:

```json
{ "path": "...", "content": "...", "size": 1234, "contentType": "text/plain" }
```

Errors: `file_not_found`, `file_too_large:...` (over 5 MB — use the REST download).

### `write_file`

Required scope: `write:drive`

Creates or overwrites a **UTF-8 text file** (max **5 MB**). Parent folders are created automatically. Text only — for binary files (PDF, images) or larger uploads, use the REST presigned flow (`POST /files/upload` → PUT → `POST /files/upload/complete`).

Input:

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `path` | string | yes | — | Absolute file path |
| `content` | string | yes | — | UTF-8 text |
| `content_type` | string | no | `text/plain` | MIME |
| `overwrite` | boolean | no | `true` | Set `false` to fail if path exists |

Output:

```json
{ "file": { "id": "...", "name": "...", "path": "...", "size": 1234, ... } }
```

Errors: `path_conflict:target is a folder`, `path_conflict:file already exists`, `file_too_large:...` (over 5 MB), `quota_exceeded:...` (would exceed the drive's total storage quota). The last two surface as JSON-RPC `-32000`.

### `search_files`

Required scope: `read:drive`

Substring match on `name` and `path`. Backed by a SQL `LIKE` query (FTS5 upgrade is planned).

Input:

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `query` | string | yes | — | Min 2 chars; shorter returns empty |
| `limit` | number | no | `50` | 1–100 |

Output:

```json
{ "query": "...", "files": [ { ... } ] }
```

### `create_share`

Required scope: `share:create`

Creates a public share link for a file or folder. Exactly one of `file_path` or `folder_path` must be supplied.

Input:

| Field | Type | Required | Notes |
|---|---|---|---|
| `file_path` | string | one of | Absolute file path |
| `folder_path` | string | one of | Absolute folder path |
| `password` | string | no | Optional access password |
| `max_downloads` | number | no | Positive integer |
| `expires_in` | number | no | Seconds from now |

Output:

```json
{
  "shareId": "abc123",
  "shareUrl": "<YOUR_AGENT_DRIVE_URL>/s/abc123",
  "hasPassword": false,
  "maxDownloads": null,
  "expiresAt": "2026-05-08T08:40:31.778Z"
}
```

Errors: `file_not_found`, `folder_not_found`, `invalid_params:exactly one of file_path or folder_path is required`.

## Errors

JSON-RPC error codes used by Agent Drive:

| Code | Meaning | When |
|---|---|---|
| `-32600` | Invalid request | Malformed JSON-RPC envelope |
| `-32601` | Method not found | Method other than `initialize` / `tools/list` / `tools/call` |
| `-32602` | Invalid params | `invalid_params:<field>`, missing tool name |
| `-32001` | Insufficient scope | `invalid_scope:<scope>` — token lacks the required capability or path scope |
| `-32000` | Tool error | Application errors (see below) |

The `message` field carries a colon-delimited code that clients can pattern-match on (e.g. `invalid_scope:write:drive`).

Application-level errors surfaced via `-32000`:

- `unknown_tool:<name>` — the tool name is not recognized. (A tool you simply lack scope for still exists — calling it returns `-32001 invalid_scope`, not this.)
- `file_not_found` / `folder_not_found` — target path does not exist.
- `path_conflict:...` — write blocked by existing entry.
- `file_too_large:...` — `write_file` content exceeds 5 MB.
- `quota_exceeded:...` — would exceed the drive's total storage quota.

Scope failures use `-32001` (`invalid_scope:<scope>`) — re-run the OAuth flow (or widen the token) with that scope requested.

## Curl example

```bash
TOKEN="<your access token>"
curl -X POST "$BASE/api/public/mcp" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_files","arguments":{"path":"/"}}}'
```

## See also

- [`oauth.md`](./oauth.md) — how to obtain access tokens
- [Setup guides](../setup/) — per-IDE config
- [MCP specification](https://modelcontextprotocol.io/specification/)
