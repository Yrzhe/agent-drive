import { Hono } from "hono";

import { withErrorHandling } from "../lib/errors";
import { APP_VERSION } from "../lib/version";

export const guideRoutes = new Hono();

guideRoutes.get(
  "/guide",
  withErrorHandling(async (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      name: "Agent Drive",
      version: APP_VERSION,
      description: "Agent-native private cloud drive. Agents upload files, create share links, persist cross-session memories, and other agents download via API — no browser needed.",
      agentSurfaces: {
        description: "All machine-facing entry points of this deployment (owner auth required except shares)",
        mcp: `${origin}/api/public/mcp — remote MCP server. Tools: list_files, read_file, write_file, search_files, create_share, remember, recall, list_memories, forget. Auth: OAuth 2.1 (discovery at ${origin}/api/public/.well-known/oauth-protected-resource) or owner AGENT_TOKEN bearer.`,
        restApi: `${origin}/api/public/v1/* — files, folders, shares, memory, bundles, webhooks, activity. Same bearer auth and scopes as MCP.`,
        memory: `Persistent agent memory with full-text search. MCP remember/recall, or REST: POST ${origin}/api/public/v1/memory, GET ${origin}/api/public/v1/memory/search?q=... Scopes: read:memory / write:memory.`,
        agentCard: `${origin}/api/public/.well-known/agent.json — A2A-compatible Agent Card (identity public key, capabilities, endpoints)`,
        llmsTxt: `${origin}/llms.txt — plain-text index of everything above`,
      },
      quickStart: {
        step1: `GET ${origin}/api/public/s/{shareId} → Get share info (type, hasPassword, fileCount, expired)`,
        step2: `POST ${origin}/api/public/s/{shareId}/access with body {"password":"xxx"} (or {} if no password) → Get accessToken (15 min TTL)`,
        step3: "Use accessToken in X-Access-Token header for all subsequent requests",
      },
      downloadSingleFile: {
        description: "For file shares or downloading a specific file from a folder share",
        endpoint: `GET ${origin}/api/public/s/{shareId}/download`,
        queryParams: "?fileId={id} (required for folder shares, get IDs from /files)",
        headers: "X-Access-Token: {accessToken}",
        returns: "{ downloadUrl, filename, size } — downloadUrl is a presigned URL valid for 1 hour",
      },
      downloadFolderAsZip: {
        description: "Download entire folder share (or a subfolder) as a ZIP archive — direct binary response",
        endpoint: `GET ${origin}/api/public/s/{shareId}/download-zip`,
        queryParams: "?path={subfolder} (optional, to download only a subfolder)",
        headers: "X-Access-Token: {accessToken}",
        returns: "Binary ZIP file (Content-Type: application/zip)",
      },
      browseFiles: {
        description: "List all files and folders in a folder share with directory structure",
        endpoint: `GET ${origin}/api/public/s/{shareId}/files`,
        headers: "X-Access-Token: {accessToken}",
        returns: "{ files: [{ id, name, path, isFolder, size, contentType }] } — path is relative to share root",
      },
      errorCodes: {
        "404 share_not_found": "Share link does not exist or was deleted",
        "410 share_expired": "Share link has expired (past expiresAt)",
        "429 share_exhausted": "Download limit reached (downloadCount >= maxDownloads)",
        "403 wrong_password": "Incorrect password",
        "401 invalid_access_token": "Access token is invalid or expired (15 min TTL — request a new one)",
      },
      exampleAgentFlow: [
        `# 1. Check share info`,
        `curl ${origin}/api/public/s/abc12345`,
        ``,
        `# 2. Get access token (with password)`,
        `curl -X POST ${origin}/api/public/s/abc12345/access -H "Content-Type: application/json" -d '{"password":"secret"}'`,
        ``,
        `# 3a. Download entire folder as ZIP (easiest for agents)`,
        `curl -o files.zip ${origin}/api/public/s/abc12345/download-zip -H "X-Access-Token: {token}"`,
        ``,
        `# 3b. Or browse and download individual files`,
        `curl ${origin}/api/public/s/abc12345/files -H "X-Access-Token: {token}"`,
        `curl "${origin}/api/public/s/abc12345/download?fileId={id}" -H "X-Access-Token: {token}"`,
        `curl -o file.txt "{downloadUrl from above}"`,
      ],
    });
  })
);
