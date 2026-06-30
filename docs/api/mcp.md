# MCP Reference

The Agent Drive MCP endpoint speaks **Streamable HTTP JSON-RPC 2.0**. Server-Sent Events are not implemented. The endpoint is:

```text
POST <YOUR_AGENT_DRIVE_URL>/api/public/mcp
```

`<YOUR_AGENT_DRIVE_URL>` is your deployment origin — see [the setup guide](../setup/mcp-claude.md#finding-your-agent-drive-url).

## Authentication

Every request **must** include:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

`<token>` is one of:

1. An OAuth 2.1 access token obtained via the [OAuth flow](./oauth.md). Scope is whatever the user approved.
2. The `AGENT_TOKEN` EdgeSpark secret on the deployment. Bypass path for self-hosted single-user mode; defaults to `read:drive write:drive share:create path:/`.

Set the optional `AGENT_TOKEN_SCOPES` var to narrow the bypass token for MCP, for example:

```text
read:drive path:/handoffs/*
```

`AGENT_TOKEN_SCOPES` can only select from the default AGENT_TOKEN MCP capabilities (`read:drive`, `write:drive`, `share:create`) plus optional `path:/...` restrictions. If it is set but malformed or includes unsupported scopes, the AGENT_TOKEN exposes no MCP tools until the var is fixed.

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
      { "name": "create_share", ... }
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

### `list_files`

Required scope: `read:drive`

Lists files and folders at a path.

Input:

| Field | Type | Default | Notes |
|---|---|---|---|
| `path` | string | `/` | Folder path to list |
| `recursive` | boolean | `false` | List descendants |
| `limit` | number | `100` | 1–200 |

Output (`text` payload, parsed):

```json
{
  "path": "/",
  "files": [
    { "id": "...", "name": "...", "path": "...", "isFolder": 0|1, "size": 1234, "contentType": "text/plain", "createdAt": "...", "updatedAt": "..." }
  ]
}
```

### `read_file`

Required scope: `read:drive`

Reads a text file by absolute path. Binary files are out of scope for MVP.

Input:

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | Absolute file path |

Output:

```json
{ "path": "...", "content": "...", "size": 1234, "contentType": "text/plain" }
```

Errors: `file_not_found`.

### `write_file`

Required scope: `write:drive`

Creates or overwrites a text file. Parent folders are created automatically.

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

Errors: `path_conflict:target is a folder`, `path_conflict:file already exists`.

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
| `-32602` | Invalid params | `unknown_tool:<name>`, `invalid_params:<field>`, `invalid_scope:<scope>` |
| `-32603` | Internal error | Storage or DB failure |

The `message` field carries a colon-delimited code that clients can pattern-match on (e.g. `invalid_scope:write:drive`).

Common application-level errors surfaced via `-32602`:

- `invalid_scope:<scope>` — token lacks the required scope. Re-run OAuth flow with that scope requested.
- `unknown_tool:<name>` — tool not implemented or filtered out by scope.
- `file_not_found` / `folder_not_found` — target path does not exist.
- `path_conflict:...` — write blocked by existing entry.

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
