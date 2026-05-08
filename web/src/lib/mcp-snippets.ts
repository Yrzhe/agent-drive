export type McpPlatform = "claude-desktop" | "claude-code" | "cursor" | "codex" | "generic";

export function getSnippet(platform: McpPlatform, url: string, scope: string): string {
  switch (platform) {
    case "claude-desktop":
      return url;
    case "claude-code":
      return `claude mcp add agent-drive --url ${url} --transport http`;
    case "cursor":
      return JSON.stringify(
        {
          mcpServers: {
            "agent-drive": {
              url,
              type: "http",
            },
          },
        },
        null,
        2,
      );
    case "codex":
      return `codex mcp add agent-drive --url ${url}
codex mcp login agent-drive`;
    case "generic":
      return `export AGENT_DRIVE_MCP_URL="${url}"
export AGENT_DRIVE_SCOPE="${scope}"
export AGENT_DRIVE_TOKEN="<oauth-access-token-or-agent-token>"

curl -i "$AGENT_DRIVE_MCP_URL" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

curl -s "$AGENT_DRIVE_MCP_URL" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $AGENT_DRIVE_TOKEN" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'`;
  }
}
