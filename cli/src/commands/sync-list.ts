import { readConfig } from "../lib/config.js";
import { type ManifestFile } from "../lib/hash.js";
import { callTool, McpToolError, type McpClientOptions } from "../lib/mcp-client.js";
import { formatBytes, formatIsoMinute, machinePrefix } from "../lib/format.js";

interface SyncListOptions {
  json?: boolean;
}

interface RemoteManifest {
  version: 1;
  name: string;
  hash: string;
  machineId: string;
  pushedAt: string;
  fileCount: number;
  totalSize: number;
  files: ManifestFile[];
  path?: string;
}

interface ToolTextResult {
  content?: Array<{ type?: string; text?: string }>;
}

interface RemoteFile {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
}

function normalizeCloudPath(value: string | undefined): string {
  const raw = value?.trim() || "/";
  const normalized = `/${raw}`.replace(/\/+/gu, "/").replace(/\/$/u, "");
  return normalized === "" ? "/" : normalized;
}

function cloudFilePath(cloudPath: string, relPath: string): string {
  return `${cloudPath.replace(/\/$/u, "")}/${relPath}`.replace(/\/+/gu, "/");
}

function parseToolJson<T>(result: unknown): T {
  const text = (result as ToolTextResult).content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (!text) throw new Error("MCP tool response did not include text JSON");
  return JSON.parse(text) as T;
}

async function listFiles(client: McpClientOptions, path: string): Promise<RemoteFile[]> {
  try {
    const result = await callTool(client, "list_files", { path, limit: 200 });
    return parseToolJson<{ files: RemoteFile[] }>(result).files ?? [];
  } catch (error) {
    if (error instanceof McpToolError && error.message.includes("file_not_found")) return [];
    if (error instanceof Error && error.message.includes("file_not_found")) return [];
    throw error;
  }
}

async function readManifest(client: McpClientOptions, path: string): Promise<RemoteManifest | null> {
  try {
    const result = await callTool(client, "read_file", { path: cloudFilePath(path, "manifest.json") });
    const file = parseToolJson<{ content: string }>(result);
    return { ...JSON.parse(file.content) as RemoteManifest, path };
  } catch (error) {
    if (error instanceof McpToolError && error.message.includes("file_not_found")) return null;
    if (error instanceof Error && error.message.includes("file_not_found")) return null;
    throw error;
  }
}

async function candidateBundlePaths(client: McpClientOptions, prefix: string): Promise<{ paths: string[]; truncated: boolean }> {
  const paths = new Set<string>([prefix]);
  let truncated = false;
  const firstLevel = (await listFiles(client, prefix)).filter((file) => file.isFolder);
  for (const dir of firstLevel) paths.add(dir.path);

  for (const dir of firstLevel) {
    const children = (await listFiles(client, dir.path)).filter((file) => file.isFolder);
    for (const child of children) paths.add(child.path);
    for (const child of children) {
      const grandchildren = (await listFiles(client, child.path)).filter((file) => file.isFolder);
      for (const grandchild of grandchildren) {
        if (await readManifest(client, grandchild.path)) truncated = true;
      }
    }
  }

  return { paths: [...paths].sort(), truncated };
}

function printTable(manifests: RemoteManifest[]): void {
  const headers = ["NAME", "PUSHED FROM", "PUSHED AT", "FILES", "SIZE"];
  const rows = manifests.map((manifest) => [
    manifest.path ?? "",
    machinePrefix(manifest.machineId),
    formatIsoMinute(manifest.pushedAt),
    String(manifest.fileCount),
    formatBytes(manifest.totalSize),
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log(formatRow(headers));
  for (const row of rows) console.log(formatRow(row));
}

export async function syncListCommand(prefixArg: string | undefined, options: SyncListOptions): Promise<void> {
  const config = await readConfig();
  if (!config) throw new Error("Not logged in. Run: adrive login --url <URL>");

  const client = config;
  const prefix = normalizeCloudPath(prefixArg);
  const { paths, truncated } = await candidateBundlePaths(client, prefix);
  const manifests = (await Promise.all(paths.map((path) => readManifest(client, path))))
    .filter((manifest): manifest is RemoteManifest => manifest !== null)
    .sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt));

  if (options.json) {
    console.log(JSON.stringify(manifests, null, 2));
    return;
  }

  if (manifests.length === 0) {
    console.log(`No bundles found under ${prefix}.`);
    if (truncated) console.log("(deeper bundles not shown, use a more specific prefix)");
    return;
  }

  printTable(manifests);
  if (truncated) console.log("(deeper bundles not shown, use a more specific prefix)");
}
