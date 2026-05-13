import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { posix } from "node:path";

import { BundleConflictError, commitBundle, getBundleCurrent, getBundleManifest, type CommitManifestInput } from "../lib/bundles.js";
import { readConfig } from "../lib/config.js";

interface SyncRollbackOptions {
  to: string;
  force?: boolean;
  yes?: boolean;
}

function normalizeCloudPath(value: string): string {
  const normalized = posix.normalize(`/${value}`).replace(/\/+$/u, "");
  return normalized === "" ? "/" : normalized;
}

async function confirm(): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Proceed with rollback? [y/N]: ");
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

export async function syncRollbackCommand(prefix: string, options: SyncRollbackOptions): Promise<void> {
  const config = await readConfig();
  if (!config) throw new Error("Not logged in. Run: adrive login --url <URL>");

  const cloudPath = normalizeCloudPath(prefix);
  if (cloudPath === "/") throw new Error("prefix must be a non-root path");

  if (!options.to.startsWith("dv_")) {
    throw new Error(`--to must be a versionId starting with dv_, got: ${options.to}`);
  }

  const current = await getBundleCurrent(config, cloudPath);
  if (!current.currentVersion) {
    throw new Error(`Bundle ${cloudPath} has no current version; nothing to rollback`);
  }
  if (current.currentVersion.versionId === options.to) {
    console.log(`Bundle ${cloudPath} is already at ${options.to}; nothing to do`);
    return;
  }

  let target;
  try {
    target = await getBundleManifest(config, cloudPath, options.to);
  } catch (error) {
    throw new Error(`Failed to fetch manifest for ${options.to}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const targetManifest = target.manifest;
  if (!targetManifest || !Array.isArray(targetManifest.files)) {
    throw new Error(`Target manifest ${options.to} is malformed`);
  }

  console.log(`Rolling back ${cloudPath}`);
  console.log(`  Current: ${current.currentVersion.versionId} (${current.currentVersion.fileCount} files)`);
  console.log(`  Target:  ${options.to} (${targetManifest.fileCount} files, originally pushed ${targetManifest.pushedAt})`);
  console.log("");
  console.log("Note: rollback restores the MANIFEST POINTER only. File bytes at");
  console.log(`  ${cloudPath}/<file> are NOT modified. Files deleted after the target`);
  console.log("  version cannot be recovered automatically — re-push from a local copy");
  console.log("  if you need their contents back.");
  console.log("");

  if (!options.force && !options.yes) {
    if (!(await confirm())) throw new Error("Aborted.");
  }

  const commitManifest: CommitManifestInput = {
    version: 1,
    name: targetManifest.name,
    hash: targetManifest.hash,
    machineId: config.machineId,
    fileCount: targetManifest.fileCount,
    totalSize: targetManifest.totalSize,
    files: targetManifest.files,
    directories: targetManifest.directories ?? [],
  };

  try {
    const result = await commitBundle(config, {
      prefix: cloudPath,
      ifMatch: current.currentVersion.versionId,
      manifest: commitManifest,
    });
    console.log(`Rolled back: new version ${result.versionId} restored from ${options.to}`);
    console.log(`  previousVersionId: ${result.previousVersionId}`);
    console.log("");
    console.log(`Note: any local checkout of ${cloudPath} now has stale sync state.`);
    console.log(`Run 'adrive sync pull --from ${cloudPath} --to <localPath>' to re-anchor.`);
  } catch (error) {
    if (error instanceof BundleConflictError) {
      throw new Error(`Cloud bundle moved during rollback (now at ${error.currentVersionId}). Retry the rollback.`);
    }
    throw error;
  }
}
