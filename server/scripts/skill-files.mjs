// Single source of truth for WHICH skill files are published and how they are hashed.
// Imported by BOTH the generator (gen-skill-manifest.mjs) and the drift-guard test, so
// they cannot compute different answers and agree with each other but not with reality.
//
// Safety (public, unauthenticated bundle):
//   - explicit allowlist — SKILL.md + references/*.md — NOT a recursive glob, so an
//     unrelated Markdown file dropped anywhere under skill/ is never auto-published.
//   - symlinks are rejected (lstat), so a link cannot pull content from outside skill/.
//   - a per-file size ceiling bounds the worker bundle.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Max bytes for any single skill file baked into the worker bundle. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** Reject symlinks so the bundle can only ever contain real files under skill/. */
function readRealFile(abs) {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new Error(`skill file is a symlink, refusing to publish: ${abs}`);
  }
  if (!st.isFile()) {
    throw new Error(`skill path is not a regular file: ${abs}`);
  }
  if (st.size > MAX_SKILL_FILE_BYTES) {
    throw new Error(`skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${abs} (${st.size})`);
  }
  // Serve exactly the file's bytes: reject anything that is not valid UTF-8, so the
  // embedded string can't silently differ from the source (which would make the manifest
  // sha256 describe mangled content the updater would then "verify" and install).
  const raw = readFileSync(abs);
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) {
    throw new Error(`skill file is not valid UTF-8, refusing to publish: ${abs}`);
  }
  return text;
}

/** The allowlisted set of publishable skill paths, relative to skillRoot, sorted. */
export function skillFilePaths(skillRoot) {
  const paths = ["SKILL.md"];
  const refDir = join(skillRoot, "references");
  for (const entry of readdirSync(refDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue; // only Markdown references are published
    // Include symlinked .md too, so readRealFile REJECTS it loudly rather than a silent
    // skip hiding a mistake — a symlink must never publish content from outside skill/.
    paths.push(`references/${entry.name}`);
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

/** Full published set with content + digest. Throws on symlink / oversize / missing. */
export function collectSkillFiles(skillRoot) {
  return skillFilePaths(skillRoot).map((rel) => {
    const abs = join(skillRoot, rel);
    const content = readRealFile(abs);
    return {
      path: relative(skillRoot, abs).split("\\").join("/"),
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      bytes: Buffer.byteLength(content, "utf8"),
      content,
    };
  });
}

export function readSkillVersion(skillRoot) {
  return readFileSync(join(skillRoot, "VERSION"), "utf8").trim();
}
