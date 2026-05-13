# adrive

Command-line client for [Agent Drive](https://github.com/yrzhe/agent-drive) — a personal cloud drive for AI agents on Cloudflare Workers + D1 + R2.

`adrive` lets you push and pull local bundles (skills, memory files, scratch dirs) to your Agent Drive deployment, version them with optimistic-concurrency commits, and bridge stdio-only MCP clients to the remote HTTP MCP endpoint.

Requires Node.js >= 18.

## Install

```bash
npm install -g adrive
```

Verify:

```bash
adrive --version
```

## Login

Browser OAuth flow (recommended):

```bash
adrive login --url https://your-deployment.workers.dev
```

Opens a browser, starts a localhost callback listener, completes PKCE S256, and stores access + refresh tokens at `~/.agent-drive/config.json` (mode `600`). Refresh tokens are rotated automatically on expiry.

Restrict the token to a subtree:

```bash
adrive login --url https://your-deployment.workers.dev \
  --scope "read:drive write:drive path:/skills/*"
```

See [OAuth scope reference](https://github.com/yrzhe/agent-drive/blob/main/docs/api/oauth.md#scope-vocabulary) for the full vocabulary (`read:drive`, `write:drive`, `share:create`, `read:memory`, `write:memory`, `read:skills`, `write:skills`, `path:/<prefix>/*`).

Print the authorization URL without opening a browser (useful on remote machines):

```bash
adrive login --url https://your-deployment.workers.dev --no-browser
```

Non-interactive `AGENT_TOKEN` fallback for CI or owner-only automation:

```bash
adrive login --url https://your-deployment.workers.dev --token "$AGENT_TOKEN"
```

## whoami / logout

```bash
adrive whoami    # show configured URL, machine ID, MCP server info
adrive logout    # delete ~/.agent-drive/config.json
```

The first login generates a persistent `machineId`; later logins keep the same `machineId` and update the URL/token fields.

## Sync

`adrive sync` mirrors a local directory to a cloud prefix. The manifest is versioned with `dv_<id>` versionIds and protected by If-Match optimistic concurrency.

### push

```bash
adrive sync push --from ~/.claude/skills/learn --to /skills/learn
```

Flags:

- `--dry-run` — preview without uploading
- `--force` — bypass the version ETag check (`ifMatch: "*"`)
- `--max-size <size>` — max single file (default `10MB`)
- `--max-files <count>` — max files in the bundle (default `5000`)

Safety defaults: single file ≤ 10 MB, bundle ≤ 100 MB, ≤ 5000 files.

On a version conflict (412), push prints a two-option resolution:

1. `adrive sync pull` to fetch the cloud state, then re-push.
2. `adrive sync push --force` to overwrite.

### pull

```bash
adrive sync pull --from /skills/learn --to ~/.claude/skills/learn
```

Flags:

- `--dry-run` — preview without downloading
- `--force` — overwrite local changes without prompting

After a successful pull, the cloud's current `versionId` is recorded in `~/.agent-drive/sync-state.json` so the next push has a fresh ETag anchor.

### list

```bash
adrive sync list /            # list bundles under root
adrive sync list /skills      # list bundles under /skills
adrive sync list / --json     # raw manifest JSON array
```

### history

List historical versions of a bundle (newest first):

```bash
adrive sync history /skills/learn
adrive sync history /skills/learn --limit 20 --json
```

Each row shows `versionId`, `pushedAt`, `machine`, `fileCount`, `size`, and `hash`.

### rollback

Restore a prior manifest as the new version (pointer-only — file bodies at `${prefix}/<file>` are not touched):

```bash
adrive sync rollback /skills/learn --to dv_abc1234567
```

Flags: `--yes` / `--force` skip the interactive confirmation.

After rolling back, other machines pointing at the prior version will need `adrive sync pull` to re-anchor before their next push.

### Ignore patterns

Default excludes:

```text
.git/  node_modules/  .DS_Store  .venv/  venv/  __pycache__/  *.pyc  *.pyo
.next/  dist/  build/
```

Add project-specific excludes via `<local>/.agent-drive-ignore` (gitignore syntax). The file is layered on top of the defaults.

```gitignore
# coverage and logs
coverage/
*.log

# local secrets
.env
secrets/**
```

Binary files are skipped in this MVP (the MCP `write_file` tool accepts text content only). The CLI logs each skipped binary and continues.

## MCP stdio bridge

For MCP clients that only speak stdio (e.g. older Claude Desktop, Gemini CLI), bridge them to the remote HTTP endpoint:

```bash
adrive mcp stdio
```

Reads `~/.agent-drive/config.json`, forwards newline-delimited JSON-RPC frames to `<URL>/api/public/mcp`, preserves request `id`, and refreshes OAuth tokens automatically on 401. Network and parse failures surface as proper JSON-RPC error objects instead of crashing the process.

Example Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

## Configuration files

| Path | Mode | Purpose |
|---|---|---|
| `~/.agent-drive/config.json` | `600` | URL, machine ID, OAuth tokens |
| `~/.agent-drive/sync-state.json` | `600` | Per-bundle last-seen `versionId` + hash, keyed by `<absolute-localPath>::<cloudPrefix>` |

`sync-state.json` is per-machine and must never be checked into a bundle directory.

## Troubleshooting

**`Session expired (...)` on push / pull**
The refresh token was revoked or expired. Re-run `adrive login --url <your URL>`.

**`invalid_scope:path:/...` on push**
Your token is path-restricted and the target is outside the granted prefix. Log in again with a wider scope or push to a path the token can see.

**Push fails with version conflict (412)**
Someone else (or another machine) pushed since your last pull. Either `adrive sync pull` then retry, or `--force` to overwrite.

**`adrive` not found after install**
Confirm npm's global `bin` is on `PATH`: `npm config get prefix` → ensure `<prefix>/bin` is in your shell `PATH`.

## Links

- Project: <https://github.com/yrzhe/agent-drive>
- OAuth reference: <https://github.com/yrzhe/agent-drive/blob/main/docs/api/oauth.md>
- Bundle versioning API: <https://github.com/yrzhe/agent-drive/blob/main/docs/api/drive-bundles.md>
- Issues: <https://github.com/yrzhe/agent-drive/issues>

## License

MIT — see [LICENSE](./LICENSE).
