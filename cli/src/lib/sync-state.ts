import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SYNC_STATE_PATH = join(homedir(), ".agent-drive", "sync-state.json");

export interface BundleSyncEntry {
  localPath: string;
  cloudPrefix: string;
  lastSeenVersionId: string | null;
  lastSeenHash: string | null;
  updatedAt: string;
}

interface SyncStateFile {
  version: 1;
  bundles: Record<string, BundleSyncEntry>;
}

function emptyState(): SyncStateFile {
  return { version: 1, bundles: {} };
}

function makeKey(localPath: string, cloudPrefix: string): string {
  return `${resolve(localPath)}::${cloudPrefix}`;
}

async function readState(): Promise<SyncStateFile> {
  try {
    const raw = await readFile(SYNC_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<SyncStateFile>;
    if (parsed && parsed.version === 1 && parsed.bundles && typeof parsed.bundles === "object") {
      return { version: 1, bundles: parsed.bundles as Record<string, BundleSyncEntry> };
    }
    return emptyState();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

async function writeState(state: SyncStateFile): Promise<void> {
  await mkdir(dirname(SYNC_STATE_PATH), { recursive: true, mode: 0o700 });
  await writeFile(SYNC_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(SYNC_STATE_PATH, 0o600);
}

export async function readBundleSyncEntry(localPath: string, cloudPrefix: string): Promise<BundleSyncEntry | null> {
  const state = await readState();
  return state.bundles[makeKey(localPath, cloudPrefix)] ?? null;
}

export async function recordBundleSync(entry: Omit<BundleSyncEntry, "updatedAt">): Promise<void> {
  const state = await readState();
  state.bundles[makeKey(entry.localPath, entry.cloudPrefix)] = {
    ...entry,
    updatedAt: new Date().toISOString(),
  };
  await writeState(state);
}

export async function forgetBundleSync(localPath: string, cloudPrefix: string): Promise<void> {
  const state = await readState();
  delete state.bundles[makeKey(localPath, cloudPrefix)];
  await writeState(state);
}
