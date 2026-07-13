# Windsurf — Agent Drive MCP Setup

Windsurf (with its Cascade chat) speaks Streamable HTTP MCP natively. Point it at your Agent Drive deployment and the OAuth dance happens in the browser.

> **Easiest path** — open `<YOUR_AGENT_DRIVE_URL>/connect` in your browser. The in-app wizard emits a Windsurf-ready snippet with your URL substituted. This document is reference material if you want to configure manually.

## Finding your Agent Drive URL

`<YOUR_AGENT_DRIVE_URL>` is the origin of your EdgeSpark deployment, for example `<YOUR_AGENT_DRIVE_URL>`. To find yours:

- Open Agent Drive in a browser, copy the origin from the URL bar.
- `edgespark deploy` prints it on first deploy.
- The EdgeSpark dashboard at `https://dashboard.edgespark.app/projects` lists your subdomain.

The MCP endpoint is always:

```text
<YOUR_AGENT_DRIVE_URL>/api/public/mcp
```

## Configure remote MCP

Open Windsurf settings → MCP servers (path varies by Windsurf version; check Windsurf's docs for the exact location). Add an entry like:

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

Restart Windsurf. On first use, Cascade opens an OAuth consent flow in your browser. Approve the requested scopes — the access token is stored by Windsurf and reused for the session.

## Cascade-specific notes

- **Tool naming**: Cascade exposes MCP tools by name in the chat. Use `list_files`, `read_file`, `write_file`, `search_files`, `create_share`, `send_file` (and the memory tools `remember`, `recall`, `list_memories`, `forget`) directly in prompts.
- **Multi-step calls**: Cascade chains MCP calls in agentic mode. No special config needed — tool scope is whatever the user approved at consent time.
- **Token refresh**: Windsurf handles OAuth refresh automatically when the access token expires. If refresh fails (token revoked, refresh expired), Cascade re-prompts for browser consent.

## Scopes

| Use case | Scopes |
|---|---|
| Full drive automation | `read:drive write:drive share:create` |
| Read-only inspection | `read:drive` |
| Memory sync | `read:memory write:memory` |

Full scope vocabulary lives in [`docs/api/oauth.md`](../api/oauth.md).

## Verify

In Cascade chat, ask:

```text
List files in Agent Drive at /
```

The tools you see depend on your token's scopes:

```text
read:drive write:drive share:create  ->  list_files, read_file, write_file, search_files, create_share, send_file
+ read:memory write:memory           ->  also remember, recall, list_memories, forget   (10 tools total)
```

If only some tools appear, the OAuth consent step downgraded scope — re-run the consent flow with broader scope from Windsurf settings.

## Self-hosted single-user mode

If your deployment sets `AGENT_TOKEN`, you can paste it as a Bearer token in Windsurf's MCP server config to skip OAuth entirely. Useful for single-user automations.

```json
{
  "mcpServers": {
    "agent-drive": {
      "url": "<YOUR_AGENT_DRIVE_URL>/api/public/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer <AGENT_TOKEN>"
      }
    }
  }
}
```

(Header injection syntax may vary by Windsurf version; consult Windsurf docs.)

## Reference

- **API reference**: [`docs/api/mcp.md`](../api/mcp.md)
- **OAuth reference**: [`docs/api/oauth.md`](../api/oauth.md)
- **Compatibility matrix**: [`compatibility.md`](./compatibility.md)
- **In-app wizard**: `<YOUR_AGENT_DRIVE_URL>/connect`
- **Discovery**: `<YOUR_AGENT_DRIVE_URL>/api/public/.well-known/oauth-protected-resource`
