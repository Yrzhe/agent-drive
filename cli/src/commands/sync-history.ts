import { posix } from "node:path";

import { getBundleHistory } from "../lib/bundles.js";
import { readConfig } from "../lib/config.js";
import { formatBytes } from "../lib/size-parser.js";

interface SyncHistoryOptions {
  json?: boolean;
  limit?: string;
}

function normalizeCloudPath(value: string): string {
  const normalized = posix.normalize(`/${value}`).replace(/\/+$/u, "");
  return normalized === "" ? "/" : normalized;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return Math.min(parsed, 200);
}

export async function syncHistoryCommand(prefix: string, options: SyncHistoryOptions): Promise<void> {
  const config = await readConfig();
  if (!config) throw new Error("Not logged in. Run: adrive login --url <URL>");

  const cloudPath = normalizeCloudPath(prefix);
  if (cloudPath === "/") throw new Error("prefix must be a non-root path");

  const limit = parseLimit(options.limit);
  const result = await getBundleHistory(config, cloudPath, limit);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.currentVersionId && result.history.length === 0) {
    console.log(`No versioned commits for ${cloudPath}.`);
    console.log(`(Bundle may have been pushed by an older CLI without versioning, or doesn't exist.)`);
    return;
  }

  console.log(`Bundle: ${cloudPath}`);
  console.log(`Current: ${result.currentVersionId ?? "<none>"}`);

  if (result.history.length === 0) {
    console.log("");
    console.log("History: <empty> (this bundle has only a single committed version)");
    return;
  }

  console.log("");
  console.log("History (most recent first):");
  console.log("");
  for (const version of result.history) {
    const pushedAt = version.pushedAt || "<unknown>";
    const machine = version.machineId ? version.machineId.slice(0, 8) : "<unknown>";
    const hashShort = version.hash ? version.hash.slice(0, 12) : "<unknown>";
    console.log(`  ${version.versionId}  ${pushedAt}  ${machine}  ${version.fileCount} files  ${formatBytes(version.totalSize)}  hash:${hashShort}`);
  }
  console.log("");
  console.log(`Restore with: adrive sync rollback ${cloudPath} --to <versionId>`);
}
