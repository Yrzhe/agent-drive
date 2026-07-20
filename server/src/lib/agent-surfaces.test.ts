import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the agent-facing surfaces listed in CLAUDE.md.
 *
 * This product's users are agents: a capability that exists in code but is
 * missing from a surface an agent reads does not exist for that agent. These
 * tests fail the moment an MCP tool is added without updating every surface
 * that enumerates the tool set.
 *
 * Each surface is narrowed to the exact passage that claims to list the whole
 * tool set. A whole-file search is NOT enough — the real drift these tests
 * were written for was a stale summary line in a file that mentioned the
 * missing tools further down, which a file-wide grep happily passes.
 */

const repoRoot = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

const SOURCE_OF_TRUTH = "server/src/lib/mcp-tools.ts";

/** Tool names as registered in the MCP server — the authoritative list. */
const registeredTools = [
  ...read(SOURCE_OF_TRUTH).matchAll(/^\s*name: "([a-z_]+)"/gmu),
].map((m) => m[1]);

/** Extracts the one passage in each surface that enumerates every tool. */
const surfaces: { path: string; extract: (content: string) => string }[] = [
  {
    // The agentSurfaces.mcp summary line served by GET /api/public/guide.
    path: "server/src/routes/guide.ts",
    extract: (content) => content.match(/^\s*mcp: `[^`]*`/mu)?.[0] ?? "",
  },
  {
    // The "Tools:" block under the /api/public/mcp entry.
    path: "web/public/llms.txt",
    extract: (content) => content.match(/Tools:\n(?:\s+.*\n)+/u)?.[0] ?? "",
  },
  {
    // The installable skill's MCP reference module documents each tool in full.
    path: "skill/references/mcp.md",
    extract: (content) => content,
  },
];

describe("agent-facing surface drift", () => {
  it("finds the registered MCP tools", () => {
    // Guards the regex above: a refactor that changes the registration shape
    // must not silently reduce this to an empty set that passes everything.
    expect(registeredTools.length).toBeGreaterThanOrEqual(16);
    expect(new Set(registeredTools).size).toBe(registeredTools.length);
  });

  it.each(surfaces)("$path documents every MCP tool", ({ path, extract }) => {
    const passage = extract(read(path));
    expect(passage, `could not locate the tool list in ${path}`).not.toBe("");

    const missing = registeredTools.filter(
      (tool) => !new RegExp(`\\b${tool}\\b`, "u").test(passage)
    );
    expect(missing, `${path} omits tools an agent would never discover`).toEqual([]);
  });
});
