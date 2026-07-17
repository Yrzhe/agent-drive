import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

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
    // Re-derive from the repo and assert equality with what the worker will serve.
    const version = readFileSync(join(skillRoot, "VERSION"), "utf8").trim();
    const collect = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) =>
        e.isDirectory() ? collect(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []
      );
    const derived = collect(skillRoot)
      .map((abs) => {
        const content = readFileSync(abs, "utf8");
        return {
          path: abs.slice(skillRoot.length + 1),
          sha256: createHash("sha256").update(content, "utf8").digest("hex"),
          bytes: Buffer.byteLength(content, "utf8"),
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));

    expect(SKILL_MANIFEST.version).toBe(version);
    expect(SKILL_MANIFEST.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })))
      .toEqual(derived);
  });
});
