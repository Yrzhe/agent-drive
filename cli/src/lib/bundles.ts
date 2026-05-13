import { apiUrl, authorizationHeader, type McpClientOptions } from "./mcp-client.js";
import type { ManifestFile } from "./hash.js";

export interface CommitManifestInput {
  version: 1;
  name?: string;
  hash: string;
  machineId: string;
  fileCount: number;
  totalSize: number;
  files: ManifestFile[];
  directories?: string[];
}

export interface CommitRequest {
  prefix: string;
  ifMatch: string | null | "*";
  manifest: CommitManifestInput;
}

export interface CommitResponse {
  versionId: string;
  previousVersionId: string | null;
  pushedAt: string;
  manifestPath: string;
  hash: string;
  fileCount: number;
  totalSize: number;
}

export class BundleConflictError extends Error {
  readonly currentVersionId: string | null;

  constructor(message: string, currentVersionId: string | null) {
    super(message);
    this.name = "BundleConflictError";
    this.currentVersionId = currentVersionId;
  }
}

interface ServerErrorBody {
  error?: {
    code?: string;
    message?: string;
    currentVersionId?: string | null;
  };
}

async function decodeJsonOrEmpty(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function commitBundle(client: McpClientOptions, request: CommitRequest): Promise<CommitResponse> {
  const response = await fetch(apiUrl(client, "/api/public/v1/bundles/commit"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": await authorizationHeader(client),
    },
    body: JSON.stringify(request),
  });
  const payload = await decodeJsonOrEmpty(response) as ServerErrorBody | CommitResponse | null;

  if (response.status === 412) {
    const errorBody = payload as ServerErrorBody | null;
    const currentVersionId = errorBody?.error?.currentVersionId ?? null;
    const message = errorBody?.error?.message ?? "Cloud bundle has moved";
    throw new BundleConflictError(message, currentVersionId);
  }

  if (!response.ok) {
    const errorBody = payload as ServerErrorBody | null;
    const message = errorBody?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`bundle commit failed: ${message}`);
  }

  return payload as CommitResponse;
}

export interface BundleCurrentResponse {
  prefix: string;
  currentVersion: {
    versionId: string;
    previousVersionId: string | null;
    machineId: string;
    hash: string;
    fileCount: number;
    totalSize: number;
    pushedAt: string;
  } | null;
}

export async function getBundleCurrent(client: McpClientOptions, prefix: string): Promise<BundleCurrentResponse> {
  const url = apiUrl(client, `/api/public/v1/bundles/current?prefix=${encodeURIComponent(prefix)}`);
  const response = await fetch(url, {
    headers: { "authorization": await authorizationHeader(client) },
  });
  if (!response.ok) throw new Error(`bundle current failed: HTTP ${response.status}`);
  return (await response.json()) as BundleCurrentResponse;
}

export interface BundleHistoryEntry {
  versionId: string;
  previousVersionId: string | null;
  hash: string;
  machineId: string;
  pushedAt: string;
  fileCount: number;
  totalSize: number;
}

export interface BundleHistoryResponse {
  prefix: string;
  currentVersionId: string | null;
  history: BundleHistoryEntry[];
}

export async function getBundleHistory(client: McpClientOptions, prefix: string, limit = 50): Promise<BundleHistoryResponse> {
  const url = apiUrl(client, `/api/public/v1/bundles/history?prefix=${encodeURIComponent(prefix)}&limit=${limit}`);
  const response = await fetch(url, {
    headers: { "authorization": await authorizationHeader(client) },
  });
  if (!response.ok) throw new Error(`bundle history failed: HTTP ${response.status}`);
  return (await response.json()) as BundleHistoryResponse;
}

export interface BundleManifestResponse {
  prefix: string;
  versionId: string;
  manifest: CommitManifestInput & {
    versionId: string;
    previousVersionId: string | null;
    pushedAt: string;
  };
}

export async function getBundleManifest(client: McpClientOptions, prefix: string, versionId: string): Promise<BundleManifestResponse> {
  const url = apiUrl(client, `/api/public/v1/bundles/manifest?prefix=${encodeURIComponent(prefix)}&versionId=${encodeURIComponent(versionId)}`);
  const response = await fetch(url, {
    headers: { "authorization": await authorizationHeader(client) },
  });
  if (!response.ok) throw new Error(`bundle manifest failed: HTTP ${response.status}`);
  return (await response.json()) as BundleManifestResponse;
}
