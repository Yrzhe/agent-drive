import { posix, resolve as resolvePath } from "node:path";

import { BundleConflictError, commitBundle, getBundleCurrent, type CommitManifestInput } from "../lib/bundles.js";
import { readConfig } from "../lib/config.js";
import { bundleHash, sha256Hex, type ManifestFile } from "../lib/hash.js";
import { apiUrl, authorizationHeader, callTool, McpToolError, type McpClientOptions } from "../lib/mcp-client.js";
import { formatBytes, parseSize } from "../lib/size-parser.js";
import { readBundleSyncEntry, recordBundleSync } from "../lib/sync-state.js";
import { type FileEntry, type SkipEntry, walkBundle } from "../lib/walker.js";

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_BUNDLE_SIZE = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5000;

interface SyncPushOptions {
  from: string;
  to: string;
  force?: boolean;
  dryRun?: boolean;
  maxSize?: string;
  maxFiles?: string;
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

interface RemoteFile {
  id: string;
  path: string;
  isFolder: boolean;
}

interface BundlePlan {
  cloudPath: string;
  files: FileEntry[];
  textFiles: FileEntry[];
  skipped: SkipEntry[];
  manifestFiles: ManifestFile[];
  hash: string;
  totalSize: number;
  directories: string[];
}

function normalizeCloudPath(value: string): string {
  const normalized = posix.normalize(`/${value}`).replace(/\/+$/u, "");
  return normalized === "" ? "/" : normalized;
}

function cloudFilePath(cloudPath: string, relPath: string): string {
  return posix.join(cloudPath, relPath);
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".md") || path.endsWith(".markdown")) return "text/markdown";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".ts")) return "text/plain";
  return "text/plain";
}

function parseToolJson<T>(result: unknown): T {
  const text = (result as ToolTextResult).content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (!text) throw new Error("MCP tool response did not include text JSON");
  return JSON.parse(text) as T;
}

function parseMaxFiles(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_FILES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--max-files must be a positive integer");
  return parsed;
}

function validateBundleSize(files: FileEntry[]): void {
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > DEFAULT_MAX_BUNDLE_SIZE) {
    throw new Error(`bundle size (${formatBytes(totalSize)}) exceeds limit (${formatBytes(DEFAULT_MAX_BUNDLE_SIZE)}).\nHint: add patterns to .agent-drive-ignore.`);
  }
}

function requireContent(file: FileEntry): Buffer {
  if (!file.contentBuffer) throw new Error(`Internal error: missing file content for ${file.relPath}`);
  return file.contentBuffer;
}

function buildPlan(to: string, files: FileEntry[], directories: string[], skipped: SkipEntry[]): BundlePlan {
  validateBundleSize(files);
  const manifestFiles = files.map((file) => ({
    path: file.relPath,
    size: file.size,
    hash: sha256Hex(requireContent(file)),
  }));
  const totalSize = manifestFiles.reduce((sum, file) => sum + file.size, 0);
  return {
    cloudPath: normalizeCloudPath(to),
    files,
    textFiles: files,
    skipped,
    manifestFiles,
    hash: bundleHash(manifestFiles),
    totalSize,
    directories,
  };
}

async function readRemoteManifest(client: McpClientOptions, cloudPath: string): Promise<RemoteManifest | null> {
  try {
    const result = await callTool(client, "read_file", { path: cloudFilePath(cloudPath, "manifest.json") });
    const file = parseToolJson<{ content: string }>(result);
    return JSON.parse(file.content) as RemoteManifest;
  } catch (error) {
    if (error instanceof McpToolError && error.message.includes("file_not_found")) return null;
    if (error instanceof Error && error.message.includes("file_not_found")) return null;
    throw error;
  }
}

function diffManifest(local: ManifestFile[], remote: RemoteManifest | null): { newFiles: ManifestFile[]; changed: ManifestFile[]; deleted: ManifestFile[]; unchanged: number } {
  const remoteByPath = new Map((remote?.files ?? []).map((file) => [file.path, file]));
  const localByPath = new Map(local.map((file) => [file.path, file]));
  const newFiles = local.filter((file) => !remoteByPath.has(file.path));
  const changed = local.filter((file) => {
    const remoteFile = remoteByPath.get(file.path);
    return remoteFile && remoteFile.hash !== file.hash;
  });
  const deleted = [...remoteByPath.values()].filter((file) => !localByPath.has(file.path));
  const unchanged = local.filter((file) => remoteByPath.get(file.path)?.hash === file.hash).length;
  return { newFiles, changed, deleted, unchanged };
}

function printDryRun(plan: BundlePlan, remote: RemoteManifest | null): void {
  const diff = diffManifest(plan.manifestFiles, remote);
  console.log(`Push preview: ${plan.cloudPath}`);
  for (const file of diff.newFiles) console.log(`  NEW       ${file.path} (${formatBytes(file.size)})`);
  for (const file of diff.changed) console.log(`  CHANGED   ${file.path} (${formatBytes(file.size)})`);
  for (const file of diff.deleted) console.log(`  DELETED   ${file.path}`);
  console.log(`  UNCHANGED ${diff.unchanged} files`);
  if (plan.skipped.length > 0) {
    for (const item of plan.skipped) {
      console.log(`  SKIPPED   ${item.path} (${item.reason})`);
      if (item.reason === "binary") console.warn(`skipping binary file: ${item.path}. Hint: add it to .agent-drive-ignore.`);
      if (item.reason === "symlink-outside") console.warn(`skipping symlink ${item.path} -> outside bundle root`);
    }
  }
  console.log(`Total: ${plan.manifestFiles.length} files, ${formatBytes(plan.totalSize)}. Would update manifest pushedAt.`);
}

async function uploadFiles(client: McpClientOptions, plan: BundlePlan): Promise<void> {
  for (let index = 0; index < plan.textFiles.length; index += 1) {
    const file = plan.textFiles[index];
    console.log(`[${index + 1}/${plan.textFiles.length}] uploading ${file.relPath}...`);
    await callTool(client, "write_file", {
      path: cloudFilePath(plan.cloudPath, file.relPath),
      content: requireContent(file).toString("utf8"),
      content_type: contentTypeFor(file.relPath),
      overwrite: true,
    });
  }
}

async function listRemoteFiles(client: McpClientOptions, cloudPath: string): Promise<RemoteFile[]> {
  const allFiles: RemoteFile[] = [];
  const limit = 200;
  for (let offset = 0; ; offset += limit) {
    const result = await callTool(client, "list_files", { path: cloudPath, recursive: true, limit, offset });
    const page = parseToolJson<{ files: RemoteFile[] }>(result);
    const files = page.files ?? [];
    allFiles.push(...files);
    if (files.length < limit) return allFiles;
  }
}

async function deleteRemoteFile(client: McpClientOptions, id: string): Promise<void> {
  const response = await fetch(apiUrl(client, `/api/public/v1/files/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: {
      "authorization": await authorizationHeader(client),
    },
  });
  if (!response.ok) throw new Error(`DELETE /api/public/v1/files/${id} failed: HTTP ${response.status}`);
}

function isServerManaged(cloudPath: string, filePath: string): boolean {
  const historyPrefix = `${cloudPath.replace(/\/$/u, "")}/.history/`;
  return filePath.startsWith(historyPrefix);
}

async function deleteOrphans(client: McpClientOptions, plan: BundlePlan): Promise<void> {
  const remoteFiles = await listRemoteFiles(client, plan.cloudPath);
  const expected = new Set([
    ...plan.manifestFiles.map((file) => cloudFilePath(plan.cloudPath, file.path)),
    cloudFilePath(plan.cloudPath, "manifest.json"),
  ]);
  const orphans = remoteFiles.filter((file) =>
    !file.isFolder
    && !expected.has(file.path)
    && !isServerManaged(plan.cloudPath, file.path)
  );
  if (orphans.length === 0) return;

  console.log(`Deleting ${orphans.length} orphan file(s)...`);
  for (const orphan of orphans) {
    console.log(`  deleting ${orphan.path}`);
    await deleteRemoteFile(client, orphan.id);
  }
}

function buildCommitManifest(plan: BundlePlan, machineId: string): CommitManifestInput {
  return {
    version: 1,
    name: plan.cloudPath.split("/").filter(Boolean).pop() ?? plan.cloudPath,
    hash: plan.hash,
    machineId,
    fileCount: plan.manifestFiles.length,
    totalSize: plan.totalSize,
    files: plan.manifestFiles,
    directories: plan.directories,
  };
}

function describeIfMatch(value: string | null | "*"): string {
  if (value === "*") return "force (--force)";
  if (value === null) return "fresh push (no prior version)";
  return value;
}

function formatConflictMessage(localPath: string, cloudPath: string, currentVersionId: string | null, lastSeen: string | null): string {
  const lines: string[] = [];
  lines.push(`Bundle ${cloudPath} has moved on the cloud.`);
  if (currentVersionId) lines.push(`  Cloud is at: ${currentVersionId}`);
  if (lastSeen) lines.push(`  You last saw: ${lastSeen}`);
  else lines.push(`  You have no local sync record for this bundle.`);
  lines.push("");
  lines.push("Resolve by one of:");
  lines.push(`  1) adrive sync pull --from ${cloudPath} --to ${localPath}    (merge cloud first)`);
  lines.push(`  2) adrive sync push --from ${localPath} --to ${cloudPath} --force    (overwrite cloud)`);
  return lines.join("\n");
}

export async function syncPushCommand(options: SyncPushOptions): Promise<void> {
  const config = await readConfig();
  if (!config) throw new Error("Not logged in. Run: adrive login --url <URL>");

  const maxFileSize = parseSize(options.maxSize, DEFAULT_MAX_FILE_SIZE);
  const maxFiles = parseMaxFiles(options.maxFiles);
  const { files, directories, skipped } = await walkBundle(options.from, {
    loadContent: true,
    skipBinary: true,
    maxFileSize,
    maxFiles,
  });
  const plan = buildPlan(options.to, files, directories, skipped);
  const client = config;
  const localAbsPath = resolvePath(options.from);

  const remote = await readRemoteManifest(client, plan.cloudPath);
  const localSyncEntry = await readBundleSyncEntry(localAbsPath, plan.cloudPath);

  if (options.dryRun) {
    printDryRun(plan, remote);
    return;
  }

  for (const item of plan.skipped) {
    if (item.reason === "binary") {
      console.warn(`skipping binary file: ${item.path}. Hint: add it to .agent-drive-ignore.`);
    } else if (item.reason === "symlink-outside") {
      console.warn(`skipping symlink ${item.path} -> outside bundle root`);
    }
  }

  const ifMatch: string | null | "*" = options.force
    ? "*"
    : localSyncEntry?.lastSeenVersionId ?? null;
  console.log(`Push ${plan.cloudPath} — ifMatch: ${describeIfMatch(ifMatch)}`);
  const current = await getBundleCurrent(client, plan.cloudPath);
  const currentVersionId = current.currentVersion?.versionId ?? null;
  if (!options.force && remote && currentVersionId === null && ifMatch === null) {
    throw new Error(formatConflictMessage(localAbsPath, plan.cloudPath, currentVersionId, localSyncEntry?.lastSeenVersionId ?? null));
  }
  if (!options.force && currentVersionId !== ifMatch) {
    throw new Error(formatConflictMessage(localAbsPath, plan.cloudPath, currentVersionId, localSyncEntry?.lastSeenVersionId ?? null));
  }

  if (remote?.hash === plan.hash && !options.force) {
    console.log("Bundle is up to date (no file changes), committing manifest pushedAt only.");
  } else {
    if (!remote) console.log(`Fresh push: ${plan.cloudPath}`);
    await uploadFiles(client, plan);
    await deleteOrphans(client, plan);
  }

  try {
    const result = await commitBundle(client, {
      prefix: plan.cloudPath,
      ifMatch,
      manifest: buildCommitManifest(plan, config.machineId),
    });
    await recordBundleSync({
      localPath: localAbsPath,
      cloudPrefix: plan.cloudPath,
      lastSeenVersionId: result.versionId,
      lastSeenHash: result.hash,
    });
    console.log(`Pushed ${plan.cloudPath}: ${plan.manifestFiles.length} files, ${formatBytes(plan.totalSize)}, hash ${plan.hash}`);
    console.log(`  versionId: ${result.versionId}${result.previousVersionId ? ` (previous: ${result.previousVersionId})` : ""}`);
  } catch (error) {
    if (error instanceof BundleConflictError) {
      throw new Error(formatConflictMessage(localAbsPath, plan.cloudPath, error.currentVersionId, localSyncEntry?.lastSeenVersionId ?? null));
    }
    throw error;
  }
}
