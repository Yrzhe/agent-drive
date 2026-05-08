# Codex MCP Connector Setup

Connector URL:

```text
https://large-gator-9215.edgespark.app/api/public/mcp
```

## Add Remote MCP

Use Codex's remote MCP add flow with the full connector URL:

```bash
codex mcp add --url https://large-gator-9215.edgespark.app/api/public/mcp agent-drive
```

If Codex prompts for browser authorization, complete the OAuth consent flow in the opened browser.

## Scopes

For normal drive automation, request:

```text
read:drive write:drive share:create
```

For inspection-only work, request:

```text
read:drive
```

## Verify

Run a tool discovery or ask Codex to use the connector:

```text
List Agent Drive files at /
```

Expected tools with full drive scopes:

```text
list_files
read_file
write_file
search_files
create_share
```
