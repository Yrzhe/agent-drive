# Claude — Agent Drive MCP Setup

This guide shows how to connect Claude (Desktop or Code CLI) to your Agent Drive deployment via Remote MCP.

> **Easiest path** — open `<YOUR_AGENT_DRIVE_URL>/connect` in your browser. The in-app wizard auto-detects your URL and gives you copy-paste-ready snippets for every supported client. The rest of this document is reference material if you want to configure manually.

## Finding your Agent Drive URL

`<YOUR_AGENT_DRIVE_URL>` is the origin of your EdgeSpark deployment, for example:

```text
<YOUR_AGENT_DRIVE_URL>
```

To find yours:

- The dashboard URL bar shows it (open Agent Drive in a browser, copy the origin).
- `edgespark deploy` prints it on first deploy.
- The EdgeSpark dashboard at `https://dashboard.edgespark.app/projects` lists your assigned subdomain.

Wherever this guide says `<YOUR_AGENT_DRIVE_URL>`, substitute that origin.

The MCP endpoint is always at:

```text
<YOUR_AGENT_DRIVE_URL>/api/public/mcp
```

## Claude Desktop (Custom Connector)

1. Open Claude → **Settings** → **Connectors**.
2. Click **Add custom connector**.
3. Set the connector URL to `<YOUR_AGENT_DRIVE_URL>/api/public/mcp`.
4. Save. Claude will open a browser tab for OAuth authorization on first use.
5. Approve the requested scopes on the consent screen.

## Claude Code CLI

```bash
claude mcp add agent-drive \
  --url <YOUR_AGENT_DRIVE_URL>/api/public/mcp \
  --transport http
```

On first use Claude Code triggers an OAuth dance via your browser.

## Scopes

Request the minimum scopes the workflow needs:

| Use case | Scopes |
|---|---|
| Full drive automation | `read:drive write:drive share:create` |
| Read-only inspection | `read:drive` |
| Memory sync (planned) | `read:memory write:memory` |
| Skill sync (planned) | `read:skills write:skills` |

Full scope vocabulary lives in [`docs/api/oauth.md`](../api/oauth.md).

## Verify

Once authorized, ask Claude to list MCP tools. With full drive scopes you should see all five:

```text
list_files
read_file
write_file
search_files
create_share
```

Sanity check by asking:

```text
Use Agent Drive to list files at /
```

## Self-hosted single-user mode

If you set `AGENT_TOKEN` as an EdgeSpark secret on your deployment, you can paste it as a Bearer token to skip the OAuth dance entirely. Useful for personal automations and CI. See [`docs/api/mcp.md`](../api/mcp.md#authentication) for details.

## Reference

- **API reference**: [`docs/api/mcp.md`](../api/mcp.md)
- **OAuth reference**: [`docs/api/oauth.md`](../api/oauth.md)
- **Compatibility matrix**: [`compatibility.md`](./compatibility.md)
- **In-app wizard**: `<YOUR_AGENT_DRIVE_URL>/connect`
- **Discovery**: `<YOUR_AGENT_DRIVE_URL>/api/public/.well-known/oauth-protected-resource`
