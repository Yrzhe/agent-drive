# Client Compatibility Matrix

Which AI agent / IDE / CLI clients work with Agent Drive, and how.

> Easiest onboarding regardless of client: open `<YOUR_AGENT_DRIVE_URL>/connect` — the in-app wizard emits config snippets for each row below.

## Quick reference

| Client | MCP transport | OAuth flow | Works via `adrive mcp stdio` | Recommended auth | Status | Setup guide |
|---|---|---|---|---|---|---|
| Claude Desktop | Streamable HTTP (Custom Connector) | ✓ | ✓ (alt) | OAuth | Supported | [mcp-claude.md](./mcp-claude.md) |
| Claude Code CLI | Streamable HTTP | ✓ | ✓ (alt) | OAuth | Supported | [mcp-claude.md](./mcp-claude.md#claude-code-cli) |
| Cursor | Streamable HTTP (`type: "http"` in `mcp.json`) | ✓ | ✓ (alt) | OAuth | Supported | [mcp-cursor.md](./mcp-cursor.md) |
| Codex CLI | Streamable HTTP (`codex mcp add --url`) | ✓ | ✓ (alt) | OAuth | Supported | [mcp-codex.md](./mcp-codex.md) |
| Gemini CLI | stdio only | via `adrive mcp stdio` | **required** | OAuth (via `adrive login`) | Supported via bridge | [mcp-gemini.md](./mcp-gemini.md) |
| Windsurf (Cascade) | Streamable HTTP | ✓ | ✓ (alt) | OAuth | Supported | [mcp-windsurf.md](./mcp-windsurf.md) |
| OpenCode | stdio (older builds) / HTTP (newer) | ✓ on HTTP builds | required on stdio builds | OAuth on HTTP, AGENT_TOKEN on stdio | Supported | (see Notes below) |
| Continue.dev | Streamable HTTP | ✓ (untested) | ✓ (alt) | OAuth (likely) | Untested in production | (TBD) |
| Browser extension MCP | varies | varies | n/a | n/a | **Out of scope** (per MVP plan) | — |

## Column meanings

- **MCP transport** — which JSON-RPC transport the client speaks natively to Agent Drive.
  - **Streamable HTTP** = remote MCP over HTTPS, single endpoint `<YOUR_AGENT_DRIVE_URL>/api/public/mcp`. Most modern clients.
  - **stdio** = newline-delimited JSON-RPC over stdin/stdout. Needs a local bridge (`adrive mcp stdio`) since Agent Drive only exposes HTTP.
- **OAuth flow** — does the client run the OAuth 2.1 dance natively (discover, register, authorize, exchange code)? `✓` = yes. Anything else needs OAuth via the CLI.
- **Works via `adrive mcp stdio`** — `adrive` ships a stdio↔HTTP proxy. For stdio-only clients this is the **only** path; for HTTP-capable clients it's an alternative (e.g. when local config is easier to manage than per-IDE remote MCP setup).
- **Recommended auth** —
  - **OAuth** = run native OAuth (`Custom Connector` flow / `claude mcp add` / `codex mcp login` / etc.) → browser consent → done.
  - **AGENT_TOKEN** = paste the deployment's bypass token. Fine for self-hosted single-user mode.
  - **OAuth (via `adrive login`)** = run `adrive login --url <URL>` once on your machine, then point the IDE at the local `adrive mcp stdio` bridge.
- **Status** —
  - **Supported** = CEO has end-to-end smoke tested it.
  - **Supported via bridge** = works through `adrive mcp stdio`, not native HTTP.
  - **Untested** = should work based on protocol compliance, no production verification yet.
  - **Out of scope** = explicitly excluded from MVP.

## OAuth vs AGENT_TOKEN — which to use

|  | OAuth | AGENT_TOKEN |
|---|---|---|
| **Setup** | Browser click | Manual paste from `edgespark var get AGENT_TOKEN` |
| **Scope** | Whatever user approved | Full (`FULL_MCP_SCOPES`) |
| **Revocable** | Per-token, via dashboard | All-or-nothing (rotate the var) |
| **Expires** | 30 min access + refresh rotation | Long-lived |
| **Good for** | Real users; multi-tool setups | Personal automations, CI, when you want zero friction |

## stdio bridge architecture

Some clients (Gemini CLI, older OpenCode) only support stdio MCP. Agent Drive itself only exposes Streamable HTTP. The CLI bridges:

```
┌─────────────┐       stdin/stdout JSON-RPC      ┌──────────────────┐
│ Gemini CLI  │ ──────────────────────────────▶  │ adrive mcp stdio │
└─────────────┘                                  └──────────────────┘
                                                          │ HTTPS + Bearer
                                                          ▼
                                              <YOUR_AGENT_DRIVE_URL>
                                              /api/public/mcp
```

The bridge reads `~/.agent-drive/config.json` for URL + token (set by `adrive login`). It forwards each JSON-RPC line, preserves `id` correlation, and auto-refreshes the OAuth token mid-session if needed.

Config snippet (stdio clients):

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

## Notes

### OpenCode

Build pre-2026 ship stdio-only — use `adrive mcp stdio`. Recent builds support HTTP MCP — use Custom Connector style config. Check your version's docs to be sure.

### Continue.dev

Continue.dev supports remote MCP over HTTP but full Agent Drive OAuth handshake hasn't been verified yet. Should work; if not, fall back to `adrive mcp stdio` + AGENT_TOKEN.

### Browser-extension MCP

Explicitly out of scope per the MVP plan. Browser-extension MCP implementations are fragile across vendors (see neuDrive's own caveats); the AI tools ecosystem is moving to native client integrations.

## See also

- [`docs/api/README.md`](../api/README.md) — base URL, authentication overview
- [`docs/api/mcp.md`](../api/mcp.md) — MCP JSON-RPC + tool schemas
- [`docs/api/oauth.md`](../api/oauth.md) — OAuth endpoints + token format
- In-app wizard: `<YOUR_AGENT_DRIVE_URL>/connect`
