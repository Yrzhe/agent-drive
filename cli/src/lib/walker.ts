import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import ignore from "ignore";

export interface FileEntry {
  absPath: string;
  relPath: string;
  size: number;
  contentBuffer: Buffer;
}

export interface BundleWalk {
  files: FileEntry[];
  directories: string[];
}

const DEFAULT_IGNORE_PATTERNS = [
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

async function readIgnorePatterns(root: string): Promise<string[]> {
  try {
    const content = await readFile(resolve(root, ".agent-drive-ignore"), "utf8");
    return content.split(/\r?\n/u);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function walkBundleTree(inputPath: string): Promise<BundleWalk> {
  const root = resolve(inputPath);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`--from must be a directory: ${inputPath}`);

  const matcher = ignore().add(DEFAULT_IGNORE_PATTERNS).add(await readIgnorePatterns(root));
  const files: FileEntry[] = [];
  const directories: string[] = [];

  async function visit(absPath: string): Promise<void> {
    const rel = toPosixPath(relative(root, absPath));
    if (rel && matcher.ignores(rel)) return;

    const item = await stat(absPath);
    if (item.isDirectory()) {
      if (rel) directories.push(rel);
      const children = await readdir(absPath);
      for (const child of children) {
        await visit(resolve(absPath, child));
      }
      return;
    }

    if (!item.isFile()) return;
    if (rel === ".agent-drive-ignore") return;
    const contentBuffer = await readFile(absPath);
    files.push({
      absPath,
      relPath: rel,
      size: item.size,
      contentBuffer,
    });
  }

  await visit(root);
  return {
    files: files.sort((a, b) => a.relPath.localeCompare(b.relPath)),
    directories: directories.sort((a, b) => a.localeCompare(b)),
  };
}

export async function walkBundle(inputPath: string): Promise<FileEntry[]> {
  return (await walkBundleTree(inputPath)).files;
}
