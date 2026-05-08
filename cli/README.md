# Agent Drive CLI

`adrive` is the command-line client for Agent Drive.

Week 2 starts with login and local machine identity. Sync commands will build on this config.

## Install

```bash
cd cli
npm install
npm run build
npm link
```

Run tests:

```bash
npm test
```

## Login

```bash
adrive login --url https://large-gator-9215.edgespark.app --token "$AGENT_TOKEN"
```

`--token-type` defaults to `agent_token`. For future OAuth access tokens:

```bash
adrive login --url https://large-gator-9215.edgespark.app --token "$TOKEN" --token-type oauth_access_token
```

Login validates the token by calling MCP `initialize` at:

```text
<URL>/api/public/mcp
```

Config is written to:

```text
~/.agent-drive/config.json
```

The file is created with mode `600`. The first login generates a persistent `machineId`; later logins keep the same `machineId` and update the URL/token fields.

## Whoami

```bash
adrive whoami
```

Prints the configured URL, machine ID, and MCP server info.

## Logout

```bash
adrive logout
```

Deletes `~/.agent-drive/config.json`.

## Sync Push

Push a local text bundle to Agent Drive:

```bash
adrive sync push --from ~/.claude/skills/learn --to /skills/learn
```

Preview changes without writing:

```bash
adrive sync push --from ~/.claude/skills/learn --to /skills/learn --dry-run
```

Overwrite a bundle last pushed by another machine:

```bash
adrive sync push --from ~/.claude/skills/learn --to /skills/learn --force
```

Limit safety defaults:

- Max single file: `10MB`
- Max bundle size: `100MB`
- Max files: `5000`

Override examples:

```bash
adrive sync push --from ./skill --to /skills/my-skill --max-size 20MB --max-files 10000
```

Default excludes:

```text
.git/ node_modules/ .DS_Store .venv/ venv/ __pycache__/ *.pyc *.pyo .next/ dist/ build/
```

Add project-specific excludes in `<local>/.agent-drive-ignore`.

Example `.agent-drive-ignore`:

```gitignore
# Generated assets
coverage/
*.log

# Local secrets
.env
secrets/**
```

Patterns use gitignore syntax and are added on top of the default excludes.

Binary files are skipped in this MVP because the Week 1 MCP `write_file` tool accepts text content only. The CLI logs each skipped binary file and continues.
