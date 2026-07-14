# Cursor — Agent Drive MCP Setup

This guide shows how to connect Cursor to your Agent Drive deployment via Remote MCP.

> **Easiest path** — open `<YOUR_AGENT_DRIVE_URL>/connect` in your browser. The in-app wizard auto-detects your URL and gives you a copy-paste-ready JSON snippet for `~/.cursor/mcp.json`. The rest of this document is reference material.

## Finding your Agent Drive URL

`<YOUR_AGENT_DRIVE_URL>` is the origin of your EdgeSpark deployment, for example:

```text
<YOUR_AGENT_DRIVE_URL>
```

To find yours:

- The dashboard URL bar shows it (open Agent Drive in a browser, copy the origin).
- `edgespark deploy` prints it on first deploy.
- The EdgeSpark dashboard at `https://dashboard.edgespark.app/projects` lists your assigned subdomain.

The MCP endpoint is always:

```text
<YOUR_AGENT_DRIVE_URL>/api/public/mcp
```

## Configure remote MCP

Edit (or create) `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-drive": {
      "url": "<YOUR_AGENT_DRIVE_URL>/api/public/mcp",
      "type": "http"
    }
  }
}
```

Restart Cursor. On first use, Cursor opens an OAuth consent flow in your browser. Approve the requested scopes.

## Scopes

| Use case | Scopes |
|---|---|
| Full drive automation | `read:drive write:drive share:create` |
| Read-only inspection | `read:drive` |
| Memory sync | `read:memory write:memory` |

Full scope vocabulary lives in [`docs/api/oauth.md`](../api/oauth.md).

## Verify

From Cursor, ask the agent:

```text
List files in Agent Drive at /
```

The tools you see depend on your token's scopes:

```text
read:drive write:drive share:create  ->  list_files, read_file, write_file, search_files, create_share, send_file
+ read:memory write:memory           ->  also remember, recall, list_memories, forget   (10 tools total)
```

## Self-hosted single-user mode

If your deployment sets `AGENT_TOKEN`, you can use it as a Bearer token to skip OAuth. See [`docs/api/mcp.md`](../api/mcp.md#authentication).

## Reference

- **API reference**: [`docs/api/mcp.md`](../api/mcp.md)
- **OAuth reference**: [`docs/api/oauth.md`](../api/oauth.md)
- **Compatibility matrix**: [`compatibility.md`](./compatibility.md)
- **In-app wizard**: `<YOUR_AGENT_DRIVE_URL>/connect`
- **Discovery**: `<YOUR_AGENT_DRIVE_URL>/api/public/.well-known/oauth-protected-resource`
