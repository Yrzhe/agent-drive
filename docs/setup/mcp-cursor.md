# Cursor MCP Connector Setup

Connector URL:

```text
https://large-gator-9215.edgespark.app/api/public/mcp
```

## Remote MCP Config

Add Agent Drive as a remote MCP server in Cursor settings. Use the full connector URL above as the server URL.

Example shape:

```json
{
  "mcpServers": {
    "agent-drive": {
      "url": "https://large-gator-9215.edgespark.app/api/public/mcp"
    }
  }
}
```

Complete the browser OAuth authorization flow if Cursor opens one.

## Scopes

Request:

```text
read:drive write:drive share:create
```

Use `read:drive` only for read-only setups.

## Verify

From Cursor, ask the agent to:

```text
List files in Agent Drive at /
```

Expected tools with full drive scopes:

```text
list_files
read_file
write_file
search_files
create_share
```
