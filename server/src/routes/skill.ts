import { Hono } from "hono";

import { SKILL_MANIFEST } from "../generated/skill-manifest";

export const skillRoutes = new Hono();

/**
 * Honest machine-discovery transport for the distributable skill.
 *
 * The skill is the public manual an agent installs; it must be fetchable with truthful
 * HTTP status. Serving it from `web/public/skill/` would hit the platform's SPA fallback
 * (any unmatched non-`/api` path returns `200 + index.html`, #46), so `curl -f` on a
 * missing file "succeeds" with the landing page. Under `/api/public/*` a miss is an
 * honest `404`. No auth: the skill contains no secrets (it ships `*.example`, never a
 * real `drive.json`), consistent with `llms.txt` and `/api/public/guide`.
 */

function contentTypeFor(path: string): string {
  return path.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
}

// Version + per-file digest, no bodies — an agent diffs this against its local copy.
skillRoutes.get("/manifest", (c) =>
  c.json({
    version: SKILL_MANIFEST.version,
    files: SKILL_MANIFEST.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
  }, 200, { "Cache-Control": "public, max-age=300" })
);

// Raw file content. Only manifest-listed paths resolve — that is both the honest-404
// contract and the path-traversal guard (a `../` or absolute path is simply not a key).
skillRoutes.get("/file", (c) => {
  const path = c.req.query("path") ?? "";
  const file = SKILL_MANIFEST.files.find((f) => f.path === path);
  if (!file) {
    return c.json({ error: "not_found", message: `No skill file at '${path}'` }, 404);
  }
  return new Response(file.content, {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(file.path),
      "Cache-Control": "public, max-age=300",
      "X-Skill-Sha256": file.sha256,
    },
  });
});
