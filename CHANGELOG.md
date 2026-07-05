# Changelog

All notable changes to this project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Memory layer (#10)** — persistent agent memory with FTS5 full-text search, the agent's cross-session external brain. New `memories` table (D1) + `memories_fts` FTS5 index maintained from application code (migration `0009_empty_praxagora.sql`; triggers were avoided because D1's migration executor cannot apply CREATE TRIGGER bodies). MCP tools: `remember` (upsert by optional stable `key`), `recall` (relevance-ranked prefix search), `list_memories`, `forget` — gated on the previously reserved `read:memory` / `write:memory` scopes, which are now part of the default `AGENT_TOKEN` grant. REST: `POST/GET /api/public/v1/memory`, `GET /memory/search?q=`, `GET|DELETE /memory/:idOrKey`, with `read:memory`/`write:memory` mapping in the scope middleware. Content capped at 8 KB per memory; activity events `memory.created/updated/deleted` (metadata never includes content). Docs: `docs/api/memory.md`, `skill/references/memory.md`.
- **Agent-facing site surfaces** — `/llms.txt` (plain-text agent index of every machine entry point) and an `agentSurfaces` section in `GET /api/public/guide` so an agent landing anywhere on the deployment can discover MCP, REST, memory, and OAuth discovery without a human.

### Security

- **Scope enforcement on every REST v1 endpoint (#3)** — `requireDualAuth` now resolves the bearer auth context once, enforces a capability scope derived from method + route (`GET/HEAD` → `read:drive`, `/v1/shares*` mutations → `share:create`, all other mutations → `write:drive`), and stores the context in Hono `c.var` for route-level checks. Routes enforce `path:` scopes wherever the target path is resolvable: file get/preview/upload/complete/move/rename/delete/restore/purge, batch delete/move (per-id `invalid_scope` failures), folder create, bundle commit/current/history/manifest, share create/get/stats/delete, and list endpoints (`/files`, `/files/search`, `/files/trash`, `/shares`, `/activity`) filter rows to the granted prefixes. Webhook management requires unrestricted (`path:/`) access since deliveries span the whole drive. Session (web) auth is unchanged. The ad-hoc `requireBearerFileAccess` / `requireBearerBundleAccess` helpers are replaced by shared `server/src/lib/rest-scopes.ts`.

### Changed

- **Trash no longer hard-purges on path reuse (#4)** — soft-deleting now renames the subtree root into a tombstone namespace (`<path>~trash~<rootId>`, descendants prefix-rewritten), so creating a file/folder at a previously-trashed path no longer silently destroys the trashed copy. Restore strips the tombstone suffix, returns `409 path_conflict` if the original path is occupied by a live item, and rows trashed before this scheme restore unchanged (legacy same-path purge kept only as fallback for those rows). `GET /files/trash` returns display paths with markers stripped.

### Fixed

- **Webhook delivery validates the destination once per attempt (#5)** — `deliverWebhook` performed the DoH SSRF validation, then `postWebhook` validated again, and the 5xx retry validated a third time (4–6 DNS queries per delivery). Validation now runs exactly once per delivery in `deliverWebhook`.

### Added

- **Trash / recycle bin (YRZ-128)** — DELETE on a file or folder is now a soft-delete: row stays in `files` with `deleted_at` set, R2 object stays put, and the row is hidden from every read path (REST list/search/get/preview, batch delete/move, MCP `list_files`/`read_file`/`write_file`/`search_files`/`create_share`, public-share download). Folder soft-delete cascades to all descendants in one `UPDATE`. Linked share rows are removed at trash time (same behavior as the prior hard-delete). New endpoints: `GET /api/public/v1/files/trash` (lists soft-deleted rows with `{ deletedAt, retention: { purgesAt, daysLeft } }`), `POST /:id/restore` (clears `deleted_at` cascade — refuses if a live row already occupies the path), `DELETE /:id/purge` (hard-delete now + R2 cleanup). Path-reuse while trashed is handled transparently: upload, MCP `write_file`, single PATCH rename/move, and batch PATCH all call `purgeConflictingTrashAtPath` before claiming a name, so trashed rows never block a fresh create at the same path. `ensureFolderChain` restores a soft-deleted folder in place when it sits on the chain. Probabilistic auto-purge (1% sample on each write path) removes rows older than 30 days plus their R2 objects. New web `/trash` route lists items with size, deletion time, days-left-to-purge, Restore, and Delete-forever buttons; dashboard header gains a "Trash" link. New activity events: `file.trashed`, `file.restored`, `file.purged`. Single DELETE response shape changed from `{ deleted: number }` to `{ trashed: number, targetId }`; batch DELETE shape from `{ deletedFiles, deletedFolders, deletedIds }` to `{ trashedFiles, trashedFolders, trashedIds }`. **Migration**: `0008_parallel_enchantress.sql` adds nullable `files.deleted_at` + index (additive, applied to D1).
- **In-dashboard file preview (YRZ-126)** — clicking a file row now opens a modal preview instead of being a dead-end. New endpoint `GET /api/public/v1/files/:id/preview` returns `{ id, name, contentType, size, downloadUrl, expiresInSecs }` with a 5-minute presigned R2 GET URL (folders rejected, in-flight uploads return `409 upload_pending`). The web `PreviewModal` renders images via `<img>`, PDFs via `<iframe>`, video/audio via the native HTML elements, and text/markdown/source-code files (txt, md, json, yaml, ts/tsx, py, sh, etc.) by fetching the body and rendering in a monospace `<pre>` (skipped with a notice past 512 KB to avoid blocking the UI). Files that don't match a known renderer show a metadata + Download CTA. The modal has a Download button (still uses the same presigned URL), Escape-to-close, and backdrop-click-to-close.
- **Bulk operations (YRZ-125)** — multi-select delete and move for files/folders. New endpoints `DELETE /api/public/v1/files/batch` (body `{ ids: string[] }`) and `PATCH /api/public/v1/files/batch` (body `{ ids: string[], parentPath: string }`), both capped at 200 ids per call. Both endpoints process ids one-by-one with per-id success/failure reporting: response is `{ requested, deletedFiles, deletedFolders, deletedIds, failures: [{ id, error, message }] }` for delete and `{ requested, moved, movedIds, parentPath, failures }` for move. Folder targets cascade exactly like the single-item handlers (descendants + linked shares cleaned via `db.batch`), and each per-id outcome writes a normal `file.deleted` / `file.moved` activity entry with `metadata.batch: true`. Move skips no-op same-parent ids, refuses moving a folder into its own subtree, and surfaces path conflicts per id without aborting the whole batch. Dashboard's `FileTable` gained a leading checkbox column with select-all (indeterminate when partial); selecting any row reveals a toolbar above the table with `Move… / Delete / Clear`. Selection auto-clears on path change or search-query change.
- **CLI npm publish prep (YRZ-244 T3.5)** — `cli/package.json` is now publishable as the unscoped `adrive` package (name confirmed available on the npm registry). Added `description`, `keywords`, `author`, `license: MIT`, `homepage`, `repository.directory: cli`, `bugs`, and `publishConfig.access: public`. `files` whitelist ships only `dist/`, `README.md`, and `LICENSE` — `npm pack --dry-run` produces a 22.7 KB tarball with 45 files and no source or test leakage. New `cli/LICENSE` (MIT). `cli/README.md` rewritten end-to-end to cover install, login (browser/headless/AGENT_TOKEN), every `sync` subcommand (push/pull/list/history/rollback), the `mcp stdio` bridge with a Claude Desktop config example, `~/.agent-drive/config.json` + `sync-state.json` reference, and a troubleshooting section. `private: true` removed.
- **Path-prefix scoped OAuth tokens (YRZ-271 T4.1)** — `path:/<absolute-prefix>/*` scope tokens (or `path:/` for root) can be attached at OAuth consent time to limit a token's file/folder blast radius to a subtree. New helpers in `server/src/lib/mcp-scopes.ts`: `parsePathScope` / `formatPathScope` / `pathAllowed` / `extractPathPrefixes` / `requirePathAllowed`. Every MCP tool that takes a path arg (`list_files`, `read_file`, `write_file`, `create_share`, plus `search_files` result filtering) enforces the granted prefixes; out-of-scope paths return `invalid_scope:path:<target>`. Tokens with no `path:*` scope retain backwards-compat "any path" behavior. The CLI's `--scope` flag validates and canonicalizes `path:` tokens client-side. Web consent UI renders path scopes in plain language ("Restrict file/folder operations to paths under /skills/"). `/connect` setup page gains a path-prefix input that appends the canonical scope to the generated config. Docs: `docs/api/oauth.md` describes the grammar + examples. Verified end-to-end: token scoped to `path:/skills/*` succeeded writes/reads under `/skills/*`, was rejected on `/memory/*` and `/test/*` with clear `invalid_scope` errors.

This release closes a full code-review pass (21 findings) and a follow-up audit (3 regressions, all addressed). Full review and audit history lives in the Maestri canvas note `review` / `reviewer-code-review`.

### Fixed

- **T3.1 audit MEDIUM follow-ups (CLI OAuth)** — three issues from the post-T3.1 review now addressed:
  - **Atomic token refresh** (`cli/src/lib/mcp-client.ts`): `refreshIfNeeded` now builds a `next` config object, persists it to disk first, and only then mutates the in-memory options. Previously the in-memory object was updated before the disk write, so a write failure left the caller using a token that was never persisted.
  - **Preserve refresh error context** (`cli/src/lib/mcp-client.ts`): the catch block previously discarded the underlying refresh error and threw a generic "Session expired" message. Now includes the original error message so network failures, invalid_grant responses, etc. are debuggable without raising logging.
  - **Client-side scope whitelist** (`cli/src/lib/oauth.ts`): `--scope` is now validated against the known scope set (`read:drive`, `write:drive`, `share:create`, `read:memory`, `write:memory`, `read:skills`, `write:skills`) before being sent. Unknown scope tokens are rejected with a clear "Known scopes: ..." message instead of being passed to the server. Also deduplicates and collapses whitespace.
- **OAuth bearer tokens now work on `/api/public/v1/*`** — `requireDualAuth` middleware previously accepted only EdgeSpark session or `AGENT_TOKEN`, silently rejecting OAuth bearer tokens that the same deployment hands out via `/api/public/oauth/token`. The middleware now delegates to `authenticateMcpBearer`, so any path the CLI exercises (`sync push` → `/v1/bundles/commit`, `/v1/files/...` orphan deletion, etc.) accepts OAuth tokens with the same scope checks the MCP surface uses. Pre-existing bug that surfaced during T4.2 smoke testing.
- **`sync push` no longer wipes `.history/*` snapshots** — `deleteOrphans()` walked the cloud bundle and considered any file not in the local manifest as orphan, which deleted server-managed `${prefix}/.history/<versionId>.json` snapshots on every push (eating the version history). Orphan detection now excludes `${prefix}/.history/`.
- **`sync rollback` prints local-state hint** — rollback creates a new versionId on the server but local sync-state files on other machines still point at the prior version. The rollback output now reminds users to re-anchor with `sync pull`.

### Security

- **Rate limiter TOCTOU race fixed** — share password attempts now use atomic SQL increment (`count = count + 1`) instead of read-modify-write, preventing concurrent bypass of the 5/15min limit.
- **Webhook SSRF hardened** — webhook URLs are now restricted to HTTPS with a public DNS hostname. **All IP literals are rejected**: every IPv4 dotted-quad (private, loopback, link-local, *and public*) and every IPv6 literal (including `[::1]`, `[fe80::]`, `[::ffff:169.254.169.254]`, ULA `fd00::`). `localhost`, `*.localhost`, and `*.internal` are also rejected. Rationale: forcing DNS resolution closes off direct-IP SSRF vectors and future RFC additions; if you previously used a raw IPv4 webhook URL, switch to a hostname.
- **Share access tokens are now revocable** — `shares` table gained a `password_version` column; tokens are bound to the version at issue time so rotating a share's password invalidates outstanding tokens.
- **Filename encoding for upload presigned URLs** — filenames containing `%` (and other URL-reserved characters) no longer fail PUT 400; the R2 object key path is properly encoded.
- **Webhook secret hint added** — `POST /api/public/v1/webhooks` response now includes a `hint` reminding clients the secret is shown only once.
- **Share metadata leak reduced** — exhausted/expired shares return minimal information to unauthenticated callers.

### Added

- **Bundle versioning (Phase 4, CLI)** — `adrive sync history <cloud-prefix>` lists historical versions (versionId / pushedAt / machine / fileCount / size / hash) with `--limit` and `--json`. `adrive sync rollback <cloud-prefix> --to <versionId>` re-commits a prior manifest as the new version (pointer-only restore; file bodies at `${prefix}/<file>` are not modified — clearly documented in the CLI prompt). Rollback uses the current versionId as `ifMatch` so concurrent commits during rollback get a clean conflict error. `--yes` / `--force` skip the interactive confirmation.
- **Bundle versioning (Phase 3, CLI)** — `adrive sync push` switched from destructive `write_file(manifest.json)` to the new `/bundles/commit` endpoint with If-Match. Per-bundle sync state (last-seen versionId + hash) lives in `~/.agent-drive/sync-state.json` keyed by `<absolute-localPath>::<cloudPrefix>` (per-machine, never written into the bundle dir). `--force` sends `ifMatch: "*"` to bypass. On 412, push prints a two-option resolution (pull-then-retry, or push --force). `adrive sync pull` now records the cloud's currentVersionId into sync-state after a successful pull, so the next push has a fresh ETag anchor.
- **Bundle versioning (Phase 2, server reads)** — `GET /api/public/v1/bundles/current?prefix=...`, `GET .../history?prefix=...&limit=N` (reads `.history/*.json` manifests, returns summaries sorted by pushedAt desc), `GET .../manifest?prefix=...&versionId=dv_xxx` (returns full historical manifest body — used by client-side rollback to commit a prior manifest as the new version).
- **Bundle versioning (Phase 1, server)** — new `POST /api/public/v1/bundles/commit` endpoint with If-Match optimistic concurrency. Every commit assigns a `dv_<10char>` versionId, snapshots the previous manifest to `${prefix}/.history/<versionId>.json`, and updates the `bundle_versions` pointer atomically via `db.batch`. Returns 412 with `currentVersionId` when the caller's `ifMatch` doesn't match cloud state. `ifMatch: "*"` bypasses (force). Race-condition guard: the pointer UPDATE is conditional on the prior versionId, so concurrent commits result in one winner and one 412. Existing `write_file` MCP and `sync push` paths are untouched. New `bundle_versions` table (additive migration `0007_abnormal_orphan.sql`).
- **`adrive mcp stdio` bridge** — local stdio↔HTTP MCP proxy so stdio-only clients (Gemini CLI, older OpenCode, older Claude Desktop) can use Agent Drive. Reads `~/.agent-drive/config.json`, forwards newline-delimited JSON-RPC to the remote `/api/public/mcp`, preserves request `id`, auto-refreshes OAuth tokens on 401, and returns proper JSON-RPC error objects on parse/network failure instead of crashing.
- **Share stats IP/UA breakdown** — `GET /api/public/v1/shares/:id/stats` now returns `ipBreakdown` (top 5) and `userAgentBreakdown` (top 5) alongside the existing aggregates. Folder ZIP downloads correctly populate `fileBreakdown` (per-file download counts).
- **File list pagination** — `GET /api/public/v1/files` accepts `limit` (default 100, max 500) and `offset` query params; response echoes both for client-side paging.
- **Activity Log retention** — entries older than 30 days are pruned probabilistically (1% sample on each write).
- **Rate Limit table cleanup** — keys with `updatedAt` older than 24h are pruned probabilistically.
- **Webhook 5xx delivery retry** — failed webhook deliveries with 5xx response are retried once after 2s before counting as failed.
- **Dashboard Share Stats UI** — expand/collapse panel shows IP top 5, User-Agent top 5, and per-file download breakdown for folder shares.

### Changed

- **⚠️ BREAKING: Webhook signature header renamed** from `X-Agent-Drive-Signature` to `X-Signature`. Existing webhook consumers must update their verification code. The HMAC-SHA256 signature value format is unchanged: `sha256=<hex>`.
- **ZIP download memory limit lowered** from 50MB to 30MB to keep peak memory well below the Workers 128MB cap.
- **Folder rename and delete are now atomic** via `db.batch()` — eliminates partial-failure inconsistency where some descendant paths were updated and others not.
- **`GET /shares` no longer N+1** — file/folder lookups batched via `inArray`, then in-memory join.
- **Share Stats query rewritten as SQL GROUP BY** instead of JS-side aggregation over all activity rows.
- **Search requires minimum 2 characters** — short-circuits sub-2-char queries with a clear validation error to avoid full-table LIKE scans.
- **ZIP per-file activity logging batched** — N file-download rows insert as a single `db.batch()`; webhook fires once per ZIP rather than per-file (downstream storage and webhook traffic dropped from O(N) to O(1)).
- **⚠️ ZIP webhook payload schema changed** — for folder ZIP downloads, the `share.downloaded` webhook event payload is now a *summary* (`fileIds: string[]`, `totalSize: number`, `count: number`) rather than one event per file. Per-file breakdown remains visible via `GET /api/public/v1/shares/:id/stats` `fileBreakdown` (driven by N activity rows still written via `db.batch`). Single-file share downloads are unchanged.

### Fixed

- Persistent rate limiting now actually works across Workers isolates (moved from in-process Map to D1 `rate_limits` table).
- Folder rename now propagates to linked share `folder_path` rows; share links survive renames.
- Folder delete cleans up linked shares atomically alongside DB metadata; orphaned shares no longer left behind.
- Upload race condition returns clean 409 instead of 500 on duplicate concurrent uploads.
- ZIP download size error returns informative 413 with `hint`, `filesEndpoint`, `fileCount`, `totalSizeMB` instead of an opaque failure.
- File size validation tolerates 10% deviation between client-reported size and stored object size.
- Removed unsafe non-null assertions (`!`) in `server/src/routes/shares.ts`, `server/src/lib/files.ts`, and `web/src/pages/DashboardPage.tsx`; code now uses optional chaining and early returns.
- `web/src/lib/api-client.ts` wraps `JSON.parse` in try/catch and throws `DriveApiError("Invalid JSON response", status, "INVALID_JSON_RESPONSE")` on malformed responses (e.g. Cloudflare challenge HTML returned as 200).
- `useCallback` dependency thrash in `DashboardPage` replaced with `useRef` for `expandedShareStats` / `loadingShareStats` / `shareStatsById`.
- `web/package.json` gained a `typecheck` script.

### Migrations

- `0003`: `activity_log` adds nullable `ip` and `user_agent` columns.
- `0004`: `shares` adds nullable `password_version` column (code defaults to `1` for legacy rows).

### Migration Notes for Webhook Consumers

If you have any active webhook consumers verifying signatures against the previous `X-Agent-Drive-Signature` header, update your verification code to read `X-Signature` instead. The HMAC value format (`sha256=<hex>`) and computation (HMAC-SHA256 over the raw request body, keyed with the per-webhook secret) are unchanged.
