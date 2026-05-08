import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import ignore from "ignore";

import { isBinaryContent } from "./binary.js";
import { formatBytes } from "./size-parser.js";

export interface FileEntry {
  absPath: string;
  relPath: string;
  size: number;
  contentBuffer?: Buffer;
}

export type SkipReason = "ignored" | "symlink-outside" | "binary" | "size";

export interface SkipEntry {
  path: string;
  reason: SkipReason;
  target?: string;
}

export interface BundleWalk {
  files: FileEntry[];
  directories: string[];
  skipped: SkipEntry[];
}

export interface WalkBundleOptions {
  loadContent?: boolean;
  skipBinary?: boolean;
  maxFileSize?: number;
  maxFiles?: number;
}

export const DEFAULT_IGNORE_PATTERNS = [
  ".git/",
  "node_modules/",
  ".DS_Store",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  "*.pyo",
  ".next/",
  "dist/",
  "build/",
];

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function isInsideRoot(realRoot: string, realTarget: string): boolean {
  const rel = relative(realRoot, realTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function readIgnorePatterns(root: string): Promise<string[]> {
  try {
    const content = await readFile(resolve(root, ".agent-drive-ignore"), "utf8");
    return content.split(/\r?\n/u);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function topContributors(files: FileEntry[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.relPath.split("/");
    const key = parts.length > 1 ? `${parts[0]}/` : ".";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([path, count]) => `  ${count} files in ${path.padEnd(20)} (consider excluding)`)
    .join("\n");
}

function enforceFileCount(files: FileEntry[], maxFiles: number): void {
  if (files.length <= maxFiles) return;
  const contributors = topContributors(files);
  throw new Error(`bundle has ${files.length} files, exceeds --max-files (${maxFiles}).\nHint: add patterns to .agent-drive-ignore. Top contributors:\n${contributors}`);
}

function enforceFileSize(file: FileEntry, maxFileSize: number): void {
  if (file.size <= maxFileSize) return;
  throw new Error(`./${file.relPath} (${formatBytes(file.size)}) exceeds --max-size (${formatBytes(maxFileSize)}).\nHint: add to .agent-drive-ignore or use --max-size ${formatBytes(file.size)}.`);
}

export async function walkBundle(rootPath: string, options: WalkBundleOptions = {}): Promise<BundleWalk> {
  const root = resolve(rootPath);
  const rootRealPath = await realpath(root);
  const rootStat = await stat(rootRealPath);
  if (!rootStat.isDirectory()) throw new Error(`--from must be a directory: ${rootPath}`);

  const matcher = ignore().add(DEFAULT_IGNORE_PATTERNS).add(await readIgnorePatterns(rootRealPath));
  const files: FileEntry[] = [];
  const directories: string[] = [];
  const skipped: SkipEntry[] = [];
  const visitedDirectories = new Set<string>();

  async function visit(absPath: string): Promise<void> {
    const rel = toPosixPath(relative(root, absPath));
    const item = await lstat(absPath);
    if (rel && (matcher.ignores(rel) || (item.isDirectory() && matcher.ignores(`${rel}/`)))) {
      skipped.push({ path: rel, reason: "ignored" });
      return;
    }

    let effectivePath = absPath;
    let effectiveStat = item;
    if (item.isSymbolicLink()) {
      const target = await realpath(absPath);
      if (!isInsideRoot(rootRealPath, target)) {
        skipped.push({ path: rel, reason: "symlink-outside", target });
        return;
      }
      effectivePath = target;
      effectiveStat = await stat(target);
    }

    if (effectiveStat.isDirectory()) {
      const realDirectory = await realpath(effectivePath);
      if (visitedDirectories.has(realDirectory)) return;
      visitedDirectories.add(realDirectory);
      if (rel) directories.push(rel);
      const children = await readdir(effectivePath);
      for (const child of children) {
        await visit(resolve(absPath, child));
      }
      return;
    }

    if (!effectiveStat.isFile()) return;
    if (rel === ".agent-drive-ignore") return;
    const file: FileEntry = {
      absPath,
      relPath: rel,
      size: effectiveStat.size,
    };
    if (options.maxFileSize !== undefined) enforceFileSize(file, options.maxFileSize);
    if (options.loadContent || options.skipBinary) {
      file.contentBuffer = await readFile(effectivePath);
    }
    if (options.skipBinary && file.contentBuffer && isBinaryContent(file.contentBuffer)) {
      skipped.push({ path: rel, reason: "binary" });
      return;
    }
    files.push(file);
  }

  await visit(root);
  files.sort((a, b) => a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  directories.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (options.maxFiles !== undefined) enforceFileCount(files, options.maxFiles);
  return { files, directories, skipped };
}
