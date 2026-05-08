import { createHash } from "node:crypto";

export interface ManifestFile {
  path: string;
  size: number;
  hash: string;
}

export function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function bundleHash(files: ManifestFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.hash);
  }
  return hash.digest("hex");
}
