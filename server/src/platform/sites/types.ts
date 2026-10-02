import type { D1Database, ExecutionContext, R2Bucket } from "@cloudflare/workers-types";
import type { PlatformRuntime } from "../types";

export interface SitesBindings {
  SITES_MCP_URL?: string;
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  OWNER_EMAIL: string;
  AGENT_TOKEN: string;
  ALLOWED_ORIGIN?: string;
  AGENT_TOKEN_SCOPES?: string;
  MAX_FILE_BYTES?: string;
  MAX_TOTAL_BYTES?: string;
  MCP_ALLOWED_ORIGINS?: string;
}
export type SitesEnv = {
  Bindings: SitesBindings;
  Variables: { platform: PlatformRuntime; ownerId?: string | null };
};
export type SitesExecutionContext = Pick<ExecutionContext, "waitUntil">;
