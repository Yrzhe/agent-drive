import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, join, resolve } from "node:path";

import { readConfig } from "../lib/config.js";
import { bundleHash, sha256Hex, type ManifestFile } from "../lib/hash.js";
import { callTool, McpToolError, type McpClientOptions } from "../lib/mcp-client.js";
import { formatBytes } from "../lib/size-parser.js";
import { type FileEntry, walkBundle } from "../lib/walker.js";

interface SyncPullOptions {
  from: string;
  to: string;
  force?: boolean;
  dryRun?: boolean;
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
  directories?: string[];
}

interface ToolTextResult {
  content?: Array<{ type?: string; text?: string }>;
}

function normalizeCloudPath(value: string): string {
  const normalized = `/${value}`.replace(/\/+/gu, "/").replace(/\/$/u, "");
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

async function readRemoteManifest(client: McpClientOptions, cloudPath: string): Promise<RemoteManifest> {
  try {
    const result = await callTool(client, "read_file", { path: cloudFilePath(cloudPath, "manifest.json") });
    const file = parseToolJson<{ content: string }>(result);
    return JSON.parse(file.content) as RemoteManifest;
  } catch (error) {
    if (error instanceof McpToolError && error.message.includes("file_not_found")) {
      throw new Error(`bundle not found at ${cloudPath}`);
    }
    if (error instanceof Error && error.message.includes("file_not_found")) {
      throw new Error(`bundle not found at ${cloudPath}`);
    }
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isNonEmptyDirectory(path: string): Promise<boolean> {
  if (!(await directoryExists(path))) return false;
  return (await readdir(path)).length > 0;
}

function localManifestFiles(entries: FileEntry[], remote: RemoteManifest): ManifestFile[] {
  const remotePaths = new Set(remote.files.map((file) => file.path));
  return entries
    .filter((entry) => remotePaths.has(entry.relPath))
    .map((entry) => ({
      path: entry.relPath,
      size: entry.size,
      hash: sha256Hex(entry.contentBuffer),
    }));
}

function diffManifest(remote: RemoteManifest, localEntries: FileEntry[]): { newFiles: ManifestFile[]; changed: ManifestFile[]; deleted: FileEntry[]; unchanged: number } {
  const localByPath = new Map(localEntries.map((entry) => [entry.relPath, entry]));
  const remoteByPath = new Map(remote.files.map((file) => [file.path, file]));
  const newFiles = remote.files.filter((file) => !localByPath.has(file.path));
  const changed = remote.files.filter((file) => {
    const local = localByPath.get(file.path);
    return local && sha256Hex(local.contentBuffer) !== file.hash;
  });
  const deleted = localEntries.filter((entry) => !remoteByPath.has(entry.relPath));
  const unchanged = remote.files.filter((file) => {
    const local = localByPath.get(file.path);
    return local && sha256Hex(local.contentBuffer) === file.hash;
  }).length;
  return { newFiles, changed, deleted, unchanged };
}

function printDryRun(cloudPath: string, remote: RemoteManifest, localEntries: FileEntry[]): void {
  const diff = diffManifest(remote, localEntries);
  console.log(`Pull preview: ${cloudPath}`);
  for (const file of diff.newFiles) console.log(`  NEW       ${file.path} (${formatBytes(file.size)})`);
  for (const file of diff.changed) console.log(`  CHANGED   ${file.path} (${formatBytes(file.size)})`);
  for (const file of diff.deleted) console.log(`  DELETED   ${file.relPath}`);
  console.log(`  UNCHANGED ${diff.unchanged} files`);
  console.log(`Total: ${remote.fileCount} files, ${formatBytes(remote.totalSize)}.`);
}

async function confirmOverwrite(localPath: string, localHash: string, remoteHash: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Local directory ${localPath} has different content than cloud (local hash: ${localHash.slice(0, 8)}..., remote: ${remoteHash.slice(0, 8)}...).\nOverwrite? [y/N]: `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function readRemoteFile(client: McpClientOptions, path: string): Promise<string> {
  const result = await callTool(client, "read_file", { path });
  return parseToolJson<{ content: string }>(result).content;
}

async function downloadFiles(client: McpClientOptions, cloudPath: string, localPath: string, remote: RemoteManifest): Promise<void> {
  for (const directory of remote.directories ?? []) {
    await mkdir(join(localPath, directory), { recursive: true });
  }
  for (let index = 0; index < remote.files.length; index += 1) {
    const file = remote.files[index];
    console.log(`[${index + 1}/${remote.files.length}] downloading ${file.path}...`);
    const content = await readRemoteFile(client, cloudFilePath(cloudPath, file.path));
    const target = join(localPath, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function deleteLocalOrphans(localPath: string, remote: RemoteManifest): Promise<void> {
  if (!(await directoryExists(localPath))) return;
  const remotePaths = new Set(remote.files.map((file) => file.path));
  const localEntries = await walkBundle(localPath);
  const orphans = localEntries.filter((entry) => !remotePaths.has(entry.relPath));
  for (const orphan of orphans) {
    await rm(orphan.absPath, { force: true });
  }
}

export async function syncPullCommand(options: SyncPullOptions): Promise<void> {
  const config = await readConfig();
  if (!config) throw new Error("Not logged in. Run: adrive login --url <URL> --token <TOKEN>");

  const client = { url: config.url, token: config.token };
  const cloudPath = normalizeCloudPath(options.from);
  const localPath = resolve(options.to);
  const remote = await readRemoteManifest(client, cloudPath);
  const localEntries = await isNonEmptyDirectory(localPath) ? await walkBundle(localPath) : [];
  const localHash = bundleHash(localManifestFiles(localEntries, remote));

  if (options.dryRun) {
    printDryRun(cloudPath, remote, localEntries);
    return;
  }

  if (localEntries.length > 0) {
    if (localHash === remote.hash) {
      console.log("Already up to date");
      return;
    }
    if (!options.force && !(await confirmOverwrite(localPath, localHash, remote.hash))) {
      throw new Error("Aborted.");
    }
  }

  await downloadFiles(client, cloudPath, localPath, remote);
  await deleteLocalOrphans(localPath, remote);
  console.log(`Pulled ${cloudPath} (${remote.fileCount} files, ${formatBytes(remote.totalSize)}) from machine ${remote.machineId.slice(0, 8)} @ ${remote.pushedAt}`);
}
