import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walkBundle } from "../src/lib/walker.js";

let root: string;

async function write(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "adrive-walker-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("walkBundle", () => {
  it("walks a normal directory recursively", async () => {
    await write(join(root, "SKILL.md"), "# Skill\n");
    await write(join(root, "references", "foo.md"), "foo\n");

    const result = await walkBundle(root, { loadContent: true });

    expect(result.files.map((file) => file.relPath)).toEqual(["SKILL.md", "references/foo.md"]);
    expect(result.files[0].contentBuffer?.toString("utf8")).toBe("# Skill\n");
  });

  it("applies default excludes", async () => {
    await write(join(root, "keep.txt"), "keep");
    await write(join(root, ".git", "config"), "secret");
    await write(join(root, "node_modules", "pkg", "index.js"), "ignored");

    const result = await walkBundle(root);

    expect(result.files.map((file) => file.relPath)).toEqual(["keep.txt"]);
    expect(result.skipped.map((item) => item.path)).toContain(".git");
    expect(result.skipped.map((item) => item.path)).toContain("node_modules");
  });

  it("applies .agent-drive-ignore patterns", async () => {
    await write(join(root, ".agent-drive-ignore"), "secret/**\n*.log\n");
    await write(join(root, "keep.txt"), "keep");
    await write(join(root, "secret", "token.txt"), "token");
    await write(join(root, "debug.log"), "log");

    const result = await walkBundle(root);

    expect(result.files.map((file) => file.relPath)).toEqual(["keep.txt"]);
    expect(result.skipped.map((item) => item.path)).toEqual(expect.arrayContaining(["debug.log", "secret/token.txt"]));
  });

  it("treats a symlink to a file inside root as a file", async () => {
    await write(join(root, "inner", "file.txt"), "real");
    await symlink("./inner/file.txt", join(root, "link-inside"));

    const result = await walkBundle(root, { loadContent: true });

    const link = result.files.find((file) => file.relPath === "link-inside");
    expect(link?.contentBuffer?.toString("utf8")).toBe("real");
  });

  it("skips a symlink pointing outside root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "adrive-outside-"));
    await write(join(outside, "hosts"), "external");
    await symlink(join(outside, "hosts"), join(root, "link-outside"));

    const result = await walkBundle(root, { loadContent: true });

    expect(result.files.map((file) => file.relPath)).not.toContain("link-outside");
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "link-outside", reason: "symlink-outside" }),
    ]));
  });

  it("throws when a file exceeds maxFileSize", async () => {
    await write(join(root, "big.bin"), Buffer.alloc(12));

    await expect(walkBundle(root, { maxFileSize: 10 })).rejects.toThrow("./big.bin (12 B) exceeds --max-size (10 B)");
  });

  it("throws when file count exceeds maxFiles with top contributors", async () => {
    await write(join(root, "src", "a.txt"), "a");
    await write(join(root, "src", "b.txt"), "b");
    await write(join(root, "docs", "c.txt"), "c");

    await expect(walkBundle(root, { maxFiles: 2 })).rejects.toThrow("Top contributors");
    await expect(walkBundle(root, { maxFiles: 2 })).rejects.toThrow("src/");
  });

  it("skips binary files when skipBinary is set", async () => {
    await write(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    await write(join(root, "text.txt"), "hello");

    const result = await walkBundle(root, { loadContent: true, skipBinary: true });

    expect(result.files.map((file) => file.relPath)).toEqual(["text.txt"]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "image.png", reason: "binary" }),
    ]));
  });
});
