# Changelog

All notable changes to this project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

This release closes a full code-review pass (21 findings) and a follow-up audit (3 regressions, all addressed). Full review and audit history lives in the Maestri canvas note `review` / `reviewer-code-review`.

### Fixed

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
