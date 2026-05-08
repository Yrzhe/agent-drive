# Codex — Agent Drive MCP Setup

This guide shows how to connect Codex CLI to your Agent Drive deployment via Remote MCP.

> **Easiest path** — open `<YOUR_AGENT_DRIVE_URL>/connect` in your browser. The in-app wizard auto-detects your URL and gives you copy-paste-ready commands. The rest of this document is reference material.

## Finding your Agent Drive URL

`<YOUR_AGENT_DRIVE_URL>` is the origin of your EdgeSpark deployment, for example:

```text
https://large-gator-9215.edgespark.app
```

To find yours:

- The dashboard URL bar shows it (open Agent Drive in a browser, copy the origin).
- `edgespark deploy` prints it on first deploy.
- The EdgeSpark dashboard at `https://dashboard.edgespark.app/projects` lists your assigned subdomain.

The MCP endpoint is always:

```text
<YOUR_AGENT_DRIVE_URL>/api/public/mcp
```

## Add as remote MCP

```bash
codex mcp add agent-drive \
  --url <YOUR_AGENT_DRIVE_URL>/api/public/mcp
```

Then trigger OAuth login:

```bash
codex mcp login agent-drive
```

Codex opens your default browser to the consent screen. Approve the requested scopes.

## Scopes

| Use case | Scopes |
|---|---|
| Full drive automation | `read:drive write:drive share:create` |
| Read-only inspection | `read:drive` |
| Memory sync (planned) | `read:memory write:memory` |
| Skill sync (planned) | `read:skills write:skills` |

Full scope vocabulary lives in [`docs/api/oauth.md`](../api/oauth.md).

## Verify

Ask Codex to list available tools. With full drive scopes you should see all five:

```text
list_files
read_file
write_file
search_files
create_share
```

Sanity check:

```text
List Agent Drive files at /
```

## Self-hosted single-user mode

If your deployment sets `AGENT_TOKEN`, you can use it as a Bearer token to skip OAuth. See [`docs/api/mcp.md`](../api/mcp.md#authentication).

## Reference

- **API reference**: [`docs/api/mcp.md`](../api/mcp.md)
- **OAuth reference**: [`docs/api/oauth.md`](../api/oauth.md)
- **In-app wizard**: `<YOUR_AGENT_DRIVE_URL>/connect`
- **Discovery**: `<YOUR_AGENT_DRIVE_URL>/api/public/.well-known/oauth-protected-resource`
