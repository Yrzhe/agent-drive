import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

// The generator's single source of truth — the drift guard and safety tests use it too.
import { MAX_SKILL_FILE_BYTES, collectSkillFiles, readSkillVersion } from "../../scripts/skill-files.mjs";
import { SKILL_MANIFEST } from "../../src/generated/skill-manifest";
import app from "../../src/index";
import { resetRuntime, runtime } from "./edge-runtime";

const skillRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skill");

describe("skill honest-discovery endpoints (#46 / unblocks #45)", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("GET /manifest lists every skill file with matching sha256 + bytes", async () => {
    const res = await app.request("/api/public/skill/manifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json() as {
      version: string;
      files: { path: string; sha256: string; bytes: number; content?: string }[];
    };
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(body.files.length).toBeGreaterThanOrEqual(9);
    expect(body.files.map((f) => f.path)).toContain("SKILL.md");
    expect(body.files.map((f) => f.path)).toContain("references/mcp.md");

    // The manifest is metadata only — never ship file bodies on the listing.
    for (const f of body.files) {
      expect(f.content).toBeUndefined();
      // Each advertised hash matches the real repo file.
      const real = readFileSync(join(skillRoot, f.path), "utf8");
      expect(f.sha256).toBe(createHash("sha256").update(real, "utf8").digest("hex"));
      expect(f.bytes).toBe(Buffer.byteLength(real, "utf8"));
    }
  });

  it("GET /file?path=SKILL.md returns the real bytes", async () => {
    const res = await app.request("/api/public/skill/file?path=SKILL.md");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(readFileSync(join(skillRoot, "SKILL.md"), "utf8"));
  });

  it("GET /file for an unknown path is an honest 404 (not the SPA 200+HTML)", async () => {
    const res = await app.request("/api/public/skill/file?path=references/nope.md");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("text/html");
  });

  it("GET /file rejects path traversal (only manifest-listed paths are served)", async () => {
    for (const p of ["../.env", "../../etc/passwd", "/etc/passwd", "drive.json"]) {
      const res = await app.request(`/api/public/skill/file?path=${encodeURIComponent(p)}`);
      expect(res.status, `traversal ${p} must 404`).toBe(404);
    }
  });

  it("the committed manifest is in sync with skill/** (drift guard)", () => {
    // Re-derive via the SAME module the generator uses, so the guard cannot compute a
    // different answer that agrees with the committed file but not with reality.
    const derived = collectSkillFiles(skillRoot).map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }));

    expect(SKILL_MANIFEST.version).toBe(readSkillVersion(skillRoot));
    expect(SKILL_MANIFEST.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }))).toEqual(derived);
  });

  describe("publish safety guards (public unauthenticated bundle)", () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "skill-guard-"));
      mkdirSync(join(tmp, "references"), { recursive: true });
      writeFileSync(join(tmp, "VERSION"), "9.9.9\n");
      writeFileSync(join(tmp, "SKILL.md"), "# skill\n");
      writeFileSync(join(tmp, "references", "ok.md"), "ok\n");
    });

    it("allowlists SKILL.md + references/*.md only — an unrelated .md is NOT published", () => {
      writeFileSync(join(tmp, "secret-notes.md"), "private\n");            // top-level, not SKILL.md
      mkdirSync(join(tmp, "internal"), { recursive: true });
      writeFileSync(join(tmp, "internal", "leak.md"), "private\n");         // other subdir
      const paths = collectSkillFiles(tmp).map((f) => f.path);
      expect(paths).toEqual(["references/ok.md", "SKILL.md"]);
    });

    it("refuses to publish a symlink (no content from outside skill/)", () => {
      const outside = join(tmpdir(), `outside-${Date.now()}.txt`);
      writeFileSync(outside, "SECRET OUTSIDE CONTENT\n");
      symlinkSync(outside, join(tmp, "references", "evil.md"));
      expect(() => collectSkillFiles(tmp)).toThrow(/symlink/iu);
    });

    it("refuses to publish an oversized file", () => {
      writeFileSync(join(tmp, "references", "huge.md"), "x".repeat(MAX_SKILL_FILE_BYTES + 1));
      expect(() => collectSkillFiles(tmp)).toThrow(/exceeds/iu);
    });
  });
});
