# Skill Discovery

The distributable agent skill (`skill/` in the repo — `SKILL.md` plus `references/*.md`)
is served from this deployment with **truthful HTTP status**, so an installed skill can
check for updates and fetch files without being lied to.

Base: `<YOUR_AGENT_DRIVE_URL>/api/public/skill`. Public, no auth (the skill is the public
manual; it contains no secrets).

## Why not `/skill/*`?

Any path outside `/api/*` that is **not a real static asset** returns **`200` + `index.html`**
(the SPA fallback — a platform limitation; the worker never sees non-`/api` paths). A real
file placed under `web/public/` does serve at `200` (that is how `/llms.txt` works) — what
is impossible is an honest **`404` on a miss**: `GET /skill/manifest.json` "succeeds" with
the landing page. Under `/api/public/*` a miss is an honest `404`, so **machines must use
the `/api/public/skill/*` paths below**, where `200` means it exists and `404` means it
does not.

## `GET /api/public/skill/manifest`

```json
{
  "version": "1.0.0",
  "files": [
    { "path": "SKILL.md", "sha256": "…", "bytes": 3216 },
    { "path": "references/mcp.md", "sha256": "…", "bytes": 4096 }
  ]
}
```

- `version` — semver from `skill/VERSION`, bumped when `skill/**` changes.
- `files[].sha256` — sha256 of the file's UTF-8 bytes. Diff against your local copy to
  detect drift; this is the integrity signal, **not** the HTTP status.
- No file bodies on the manifest — fetch each with `/file`.

`Cache-Control: public, max-age=300`.

## `GET /api/public/skill/file?path=<path>`

Returns one file's raw content. `path` must be exactly a `path` from the manifest.

- `200` with `Content-Type: text/markdown; charset=utf-8` and an `X-Skill-Sha256` header.
- `404 { "error": "not_found" }` for any path not in the manifest — which also means a
  `../` or absolute path is simply not found (only manifest-listed paths resolve, so
  there is no path traversal).

## Client contract (for a self-updater)

1. `GET /manifest`, parse **strictly as JSON**; abort if it is HTML (defends against a
   misconfigured deployment or a wrong URL).
2. For each changed file, `GET /file?path=…`, and **verify sha256 against the manifest**
   before writing.
3. Never overwrite local config (`drive.json`, `.env`) even if a manifest lists it —
   a client-side denylist, not a server omission.

## Maintaining the manifest

The served manifest is generated and **committed** (`server/src/generated/skill-manifest.ts`)
because `edgespark deploy` runs its own bundler with no npm build hook — a gitignored
artifact would be missing at bundle time. After editing anything under `skill/` or bumping
`skill/VERSION`:

```bash
cd server && npm run gen:skill   # regenerate the committed manifest
npm test                          # the skill-manifest.sync test fails if it drifted
```

The `skill-manifest.sync` test re-derives the manifest through the same module the
generator uses (`server/scripts/skill-files.mjs`) and fails on any drift. There is no CI
gate in this repo, so **the full suite must be run before every deploy** — the standard
definition-of-done — which is what makes that test the effective gate. Publishing is
allowlisted (`SKILL.md` + `references/*.md`), symlinks are rejected, and a per-file size
ceiling bounds the bundle, so an unrelated or linked file can never be served.

See also: the `skill` and `note` entries in `GET /api/public/guide` → `agentSurfaces`.
