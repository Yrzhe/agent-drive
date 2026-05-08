# Claude MCP Connector Setup

Connector URL:

```text
https://large-gator-9215.edgespark.app/api/public/mcp
```

## Custom Connector

1. Open Claude connector settings.
2. Add a custom remote MCP connector.
3. Use the connector URL above.
4. Complete the browser authorization prompt.

## Scopes

Request only the scopes needed by the workflow:

```text
read:drive write:drive share:create
```

Read-only workflows can request:

```text
read:drive
```

## Verify

After authorization, ask Claude to list available MCP tools. Expected tools with full drive scopes:

```text
list_files
read_file
write_file
search_files
create_share
```

Then verify a simple read path:

```text
Use Agent Drive to list files at /
```
