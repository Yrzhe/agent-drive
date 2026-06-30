# Agent Drive product audit and here.now comparison

Date: 2026-06-30

This audit captures the current shipped surface, obvious bugs found by code review
and local verification, and product lessons from here.now Drive. It is intended to
be a reviewable backlog source rather than a full remediation PR.

## Current product surface

### Web app

- Dashboard at `/`: file browser, upload zone, search, folder creation, rename,
  move, delete, batch operations, preview, share creation, and share stats.
- Public share page at `/s/:shareId`: password gate, file download, and folder
  ZIP download.
- `/guide`: renders the public agent guide API.
- `/connect`: MCP connector setup, platform snippets, scope picker, path scope
  helper, and endpoint probe.
- `/connect/authorize`: OAuth consent UI for MCP clients.
- `/bundles`: bundle status page for synced manifests.
- `/trash`: restore and permanent purge for soft-deleted files.

### Server API

- File and folder APIs under `/api/public/v1/files` and
  `/api/public/v1/folders`.
- Public share APIs under `/api/public/s/:shareId`.
- Owner/agent share management under `/api/public/v1/shares`.
- MCP JSON-RPC endpoint at `/api/public/mcp`.
- OAuth registration, authorize, token, refresh, and discovery routes.
- Bundle commit/current/history/manifest routes under `/api/public/v1/bundles`.
- Activity log and webhook CRUD/test delivery routes.
- Storage via R2 bucket `drive`; metadata via D1/Drizzle.

### CLI

- `adrive login`, `logout`, `whoami`.
- `adrive mcp stdio` bridge.
- `adrive sync push`, `pull`, `list`, `history`, `rollback`.
- OAuth PKCE, bearer token login, token refresh, local sync-state, bundle hash
  calculation, binary skip, and `.agent-drive-ignore`.

## Verification performed

Passed:

- `server`: `npm run typecheck`
- `web`: `npm run build`
- `cli`: `npm run check`
- `cli`: `npm test` (6 files, 30 tests)

Initial audit failed or warned:

- `web`: `npm run lint`
  - `web/src/pages/ConnectSetupPage.tsx`: `no-control-regex`
  - `web/src/vite-env.d.ts`: unused generic parameter
- `server`: `npm audit` reports 4 moderate vulnerabilities via
  `drizzle-kit -> esbuild`.
- `cli`: `npm audit` reports 1 high vulnerability via `vite`.

Latest repair verification:

- `server`: `npm run typecheck`
- `web`: `npm run lint`
- `web`: `npm run build`
- `cli`: `npm run check`
- `cli`: `npm test` (6 files, 30 tests)

## Repair progress

Status is updated as fixes land on this PR.

| Status | Priority | Item | Notes |
| --- | --- | --- | --- |
| Done | P0 | Bundle page live API integration | Replaced nonexistent `/files/read` calls with `/api/public/v1/bundles/current` and `/manifest`. |
| Done | P0 | OAuth consent completion | Replaced native form navigation with `fetch` plus redirect to returned `redirect_uri`. |
| Done | P0 | OAuth consent auth gate | Added login gate and current authorize URL redirect preservation. |
| Done | P0 | Public shares exclude trashed downloads | Added `deletedAt IS NULL` filters for single-file and ZIP downloads. |
| Done | P1 | Prevent sharing trashed targets | Share creation now validates only non-trashed files/folders. |
| Done | P1 | Exclude trash from drive stats | File/folder/count/size stats now ignore soft-deleted rows. |
| Done | P1 | Folder creation vs trashed path behavior | Folder creation now purges same-path trash before checking active conflicts. |
| Done | P1 | Folder creation unique-race handling | Concurrent path insert races now normalize to `409 path_conflict`. |
| Done | P2 | Fix web lint | Removed the control-character regex lint violation and scoped the React directory attribute augmentation. |
| Done | Follow-up | OAuth Deny open redirect | Deny now posts to the server and uses server-validated `redirect_uri`. |
| Done | Follow-up | OAuth custom public origin | Consent CSRF origin check now accepts configured `ALLOWED_ORIGIN` as well as request origin. |
| Done | Follow-up | Auth UI cleanup | Login panel now calls the auth UI destroy handle on unmount/remount. |
| Done | Follow-up | Bundle relative file links and orphan manifests | Bundle file links include the bundle prefix; orphan `manifest.json` files are ignored. |
| Done | Follow-up | Bundle soft-deleted manifests | Bundle commit/manifest/history paths now avoid soft-deleted manifest rows. |
| Done | Follow-up | Escaped descendant path matching | Recursive path queries now escape `%`, `_`, and `\\` to avoid sibling leaks/purges. |
| Done | Follow-up | Root folder shares | `/` is now supported as a virtual root folder share for REST, MCP, metadata, listing, single download, and ZIP. |
| Done | P1 | Reduce `AGENT_TOKEN` blast radius | MCP `AGENT_TOKEN` now defaults to implemented drive/share scopes and can be narrowed with `AGENT_TOKEN_SCOPES`, including path scopes. |
| Done | P1 | Re-check webhook destinations at delivery time | Registration/delivery validate public HTTPS plus DNS A/AAAA results and delivery does not automatically follow redirects; pinned-resolution TOCTOU remains a platform/proxy concern. |
| Done | P1 | Harden CLI sync concurrency | Push preflights current version before upload/delete, pull records exact version anchors, and orphan cleanup pages through scoped MCP listings. |
| Done | P2 | Address npm audit findings | Server/web/CLI `npm audit --audit-level=moderate` now report 0 vulnerabilities; unused vulnerable `drizzle-kit` was removed and CLI lockfile updated. |
| Backlog | P2 | Add server and web tests | Not yet changed in this PR. |
| Backlog | P2 | Refresh README and skill docs | Not yet changed in this PR. |

## Proposed issue backlog

### P0

1. **Fix the Bundles page live API integration**
   - `web/src/lib/drive-api.ts` calls `/api/public/v1/files/read` and
     `/api/files/read`.
   - The server does not expose either route.
   - Use the existing bundle APIs instead:
     `/api/public/v1/bundles/current`, `/history`, and `/manifest`.

2. **Fix OAuth consent completion**
   - The frontend submits a native form from
     `web/src/pages/ConnectAuthorizePage.tsx`.
   - The server returns JSON containing `redirect_uri` from
     `server/src/routes/oauth.ts`, so the browser lands on a raw JSON page.
   - Replace form navigation with `fetch`, then `window.location.assign()` to
     the returned redirect URI.

3. **Add auth gating to the OAuth consent UI**
   - The consent POST requires `auth.isAuthenticated()`.
   - The React page currently shows Allow/Deny without checking login state.
   - Reuse `useAuth` and `AuthLoginPanel`, preserving the current URL after
     login.

4. **Exclude trashed files from public share downloads**
   - Single-file share download is missing `deletedAt IS NULL`.
   - Folder ZIP file selection is also missing `deletedAt IS NULL`.
   - Existing share links should not expose files after trashing.

### P1

5. **Prevent sharing trashed targets**
   - Share creation validates `fileId` and `folderPath` without checking
     `deletedAt`.

6. **Exclude trash from drive stats**
   - File/folder/size stats include soft-deleted rows.

7. **Make folder creation match upload conflict behavior**
   - Upload purges conflicting trash before inserting.
   - Folder creation returns path conflict for the same condition.

8. **Reduce `AGENT_TOKEN` blast radius**
   - `AGENT_TOKEN` previously granted full MCP scopes.
   - Prefer per-agent OAuth or first-class scoped Drive tokens for routine
     automation.

9. **Re-check webhook destinations at delivery time**
   - Registration and delivery now validate public HTTPS URLs and DNS A/AAAA
     results before sending.
   - Delivery uses manual redirect handling so 3xx responses cannot redirect to
     private/internal targets.
   - Residual DNS TOCTOU remains because Worker `fetch(url)` resolves again;
     eliminating that requires a platform-supported pinned origin or webhook
     egress proxy.

10. **Harden CLI sync concurrency**
    - `sync pull` records the exact current version it read, including when
      hashes already match.
    - `sync push` avoids uploading file changes before detecting stale or
      unanchored remote bundle conflicts.
    - Orphan cleanup paginates through scoped MCP listings beyond the original
      200-file cap.
    - Residual: file bytes and manifest artifacts are not staged atomically with
      the bundle pointer, so a remote move after preflight can still leave
      uploaded bytes or a temporarily inconsistent `manifest.json` artifact if
      the manifest commit loses the race.

### P2

11. **Fix web lint**
12. **Address npm audit findings**
13. **Add server and web tests**
14. **Refresh README and skill docs for CLI, MCP, OAuth, bundles, trash, and
    webhooks**

## here.now Drive comparison

Sources reviewed:

- https://here.now/docs
- https://here.now/llms.txt
- https://www.here.now/
- https://github.com/heredotnow/skill/blob/HEAD/here-now/SKILL.md

### What here.now emphasizes

- **Two clear jobs:** Sites for public static publishing, Drives for private
  agent storage.
- **Default drive:** every account has a default `My Drive`, lazily created.
- **Scoped Drive tokens:** read/write permissions, optional path prefix, optional
  TTL, token labels, and revocation/listing.
- **Pasteable handoff block:** `herenow_drive` includes `api_base`, drive id,
  bearer token, permissions, scope, expiry, and optional `pathPrefix`.
- **ETag/version discipline:** direct writes preserve ETags; batch operations can
  use `baseVersionId` for atomic multi-file changes.
- **Helper script first:** `scripts/drive.sh` wraps staged uploads, ETags, share
  blocks, and folder import/export.
- **Attribution:** file listings include `lastModifiedBy` and `lastOperation`,
  with token labels displayed in the dashboard.
- **Publish from Drive:** a Drive version can be published as a static Site
  server-side without download/re-upload.
- **Agent-readable docs:** `llms.txt`, agent manifests, skill docs, and OpenAPI
  are explicitly advertised.

### Lessons for Agent Drive

1. **Reframe product language around durable agent storage**
   - Current Agent Drive messaging is strong on file sharing.
   - here.now makes the "memory/plans/research/assets across sessions" use case
     very explicit. Agent Drive should do the same in README, guide, and web UI.

2. **Promote scoped tokens over `AGENT_TOKEN`**
   - Agent Drive already has OAuth scopes and path scopes.
   - A first-class "Create agent token" flow in the dashboard would be easier
     than asking agents to reuse owner sessions or a long-lived bypass secret.

3. **Add pasteable share/token handoff blocks**
   - Current shares are human-friendly links plus passwords.
   - Add a structured block for agents, e.g. `agent_drive` with `apiBase`,
     `shareId` or token id, `token`, `permissions`, `pathPrefix`, and expiry.

4. **Move from path-only sharing to Drive-scoped token sharing**
   - Agent Drive shares are good for download handoff.
   - For collaborative agents, add scoped read/write tokens against a subtree so
     another agent can write back safely.

5. **Add version/ETag semantics to file operations**
   - Bundles have optimistic concurrency, but normal file operations do not have
     obvious ETag-like checks.
   - Introduce per-file versions for safe overwrite/move/delete and batch
     changes.

6. **Improve attribution**
   - Activity logs exist, but file rows do not expose "last edited by".
   - Add token/client labels and surface them in the dashboard and API.

7. **Make helper tooling the recommended path**
   - `adrive` is powerful but underrepresented in the root README and skill docs.
   - Bring CLI workflows into the primary onboarding path, similar to
     here.now's `drive.sh`.

8. **Consider publish-from-drive as a differentiator**
   - Agent Drive already stores bundles and files.
   - If product scope includes public output, a "publish this folder" path would
     connect private agent storage to shareable artifacts.

## Suggested next PRs

1. Add server and web tests.
2. Refresh README and skill docs.
