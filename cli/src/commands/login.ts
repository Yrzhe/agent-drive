import { randomUUID } from "node:crypto";

import { readConfig, writeConfig, type AgentDriveConfig, type TokenType } from "../lib/config.js";
import { initializeMcp, normalizeBaseUrl } from "../lib/mcp-client.js";

interface LoginOptions {
  url: string;
  token: string;
  tokenType: string;
}

function parseTokenType(value: string): TokenType {
  if (value === "agent_token" || value === "oauth_access_token") return value;
  throw new Error("Invalid --token-type. Expected agent_token or oauth_access_token.");
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const url = normalizeBaseUrl(options.url);
  const token = options.token.trim();
  if (!token) throw new Error("--token must not be empty");

  const tokenType = parseTokenType(options.tokenType);
  await initializeMcp({ url, token });

  const existing = await readConfig();
  const now = new Date().toISOString();
  const config: AgentDriveConfig = {
    version: 1,
    url,
    token,
    tokenType,
    machineId: existing?.machineId ?? randomUUID(),
    createdAt: existing?.createdAt ?? now,
  };

  await writeConfig(config);
  console.log(`Logged in to ${url} as machine ${config.machineId}`);
}
