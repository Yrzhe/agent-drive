# Gemini CLI — Agent Drive MCP Setup

Gemini CLI speaks stdio MCP only. Agent Drive exposes Streamable HTTP MCP. The bridge: run `adrive mcp stdio` locally — it forwards stdio JSON-RPC to your remote Agent Drive deployment.

> **Easiest path** — open `<YOUR_AGENT_DRIVE_URL>/connect` in your browser. The in-app wizard emits a Gemini-ready snippet with your URL substituted. This document is reference material if you want to configure manually.

## Prerequisites

1. **Install `adrive` CLI** — Agent Drive's command-line tool that includes the stdio bridge. From the repo:

   ```bash
   cd cli && npm install && npm link
   adrive --help
   ```

2. **Log in to your deployment** — runs the OAuth browser dance once per machine:

   ```bash
   adrive login --url <YOUR_AGENT_DRIVE_URL>
   ```

   A browser tab opens, you approve the requested scopes, the CLI saves the token to `~/.agent-drive/config.json`. See [`docs/api/oauth.md`](../api/oauth.md) for the full flow.

   Single-user self-hosted? You can use `--token <AGENT_TOKEN>` instead and skip OAuth entirely.

## Finding your Agent Drive URL

`<YOUR_AGENT_DRIVE_URL>` is the origin of your EdgeSpark deployment, for example `https://large-gator-9215.edgespark.app`. To find yours:

- Open Agent Drive in a browser, copy the origin from the URL bar.
- `edgespark deploy` prints it on first deploy.
- The EdgeSpark dashboard at `https://dashboard.edgespark.app/projects` lists your subdomain.

## Gemini config

Edit Gemini CLI's MCP config (typically `~/.gemini/config.json` or your platform's equivalent — check Gemini's docs for the exact path):

```json
{
  "mcpServers": {
    "agent-drive": {
      "command": "adrive",
      "args": ["mcp", "stdio"]
    }
  }
}
```

That's the whole config. The bridge reads your deployment URL and token from `~/.agent-drive/config.json` — they don't need to live in Gemini's config.

Restart Gemini CLI. On first use the bridge proxies the `initialize` and `tools/list` calls to your deployment.

## Scopes

| Use case | Scopes |
|---|---|
| Full drive automation | `read:drive write:drive share:create` |
| Read-only inspection | `read:drive` |
| Memory sync (planned) | `read:memory write:memory` |
| Skill sync (planned) | `read:skills write:skills` |

Override the default scope at login time: `adrive login --url <URL> --scope "read:drive"`. See [`docs/api/oauth.md`](../api/oauth.md) for the full vocabulary.

## Verify

Ask Gemini to list available MCP tools. With full drive scopes you should see all five:

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

## Token refresh

OAuth access tokens expire (default 30 min). The bridge auto-refreshes via the stored refresh token. If the refresh token also expires (default 7 days), the bridge errors out — re-run `adrive login`.

## Troubleshooting

- **"Not logged in"** — run `adrive login --url <YOUR_AGENT_DRIVE_URL>` first.
- **`adrive: command not found`** — `npm link` failed or `npm` global bin isn't on `PATH`. Check `npm config get prefix` and add `<prefix>/bin` to `PATH`.
- **Bridge crashes mid-session** — check `~/.agent-drive/config.json` is valid JSON. Try `adrive whoami` to confirm credentials work standalone.

## Reference

- **API reference**: [`docs/api/mcp.md`](../api/mcp.md)
- **OAuth reference**: [`docs/api/oauth.md`](../api/oauth.md)
- **Compatibility matrix**: [`compatibility.md`](./compatibility.md)
- **In-app wizard**: `<YOUR_AGENT_DRIVE_URL>/connect`
- **Discovery**: `<YOUR_AGENT_DRIVE_URL>/api/public/.well-known/oauth-protected-resource`
