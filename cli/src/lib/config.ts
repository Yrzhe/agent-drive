import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TokenType = "agent_token" | "oauth_access_token";

export interface AgentDriveConfig {
  version: 1;
  url: string;
  token: string;
  tokenType: TokenType;
  clientId?: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  machineId: string;
  createdAt: string;
}

export const CONFIG_PATH = join(homedir(), ".agent-drive", "config.json");

function isTokenType(value: unknown): value is TokenType {
  return value === "agent_token" || value === "oauth_access_token";
}

function parseConfig(value: unknown): AgentDriveConfig | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AgentDriveConfig>;
  if (
    candidate.version !== 1 ||
    typeof candidate.url !== "string" ||
    typeof candidate.token !== "string" ||
    !isTokenType(candidate.tokenType) ||
    typeof candidate.machineId !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }
  return {
    version: 1,
    url: candidate.url,
    token: candidate.token,
    tokenType: candidate.tokenType,
    ...(typeof candidate.clientId === "string" ? { clientId: candidate.clientId } : {}),
    ...(typeof candidate.refreshToken === "string" ? { refreshToken: candidate.refreshToken } : {}),
    ...(typeof candidate.expiresAt === "string" ? { expiresAt: candidate.expiresAt } : {}),
    ...(typeof candidate.scope === "string" ? { scope: candidate.scope } : {}),
    machineId: candidate.machineId,
    createdAt: candidate.createdAt,
  };
}

export async function readConfig(): Promise<AgentDriveConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = parseConfig(JSON.parse(raw) as unknown);
    if (!parsed) throw new Error(`Invalid Agent Drive config at ${CONFIG_PATH}`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeConfig(config: AgentDriveConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
}

export async function deleteConfig(): Promise<void> {
  await rm(CONFIG_PATH, { force: true });
}
