# 2026-05-08 — MCP Endpoint MVP

## Goal

Add a Remote MCP endpoint to agent-drive so Claude / Codex / Cursor / Windsurf / Gemini CLI users can connect by pasting a single URL (`https://<host>/mcp`), authorize via OAuth in the browser, and call agent-native tools (sync skills, sync memory, list/read/write files, create shares).

This is the strategic shift from "general-purpose drive accessed via bearer token + REST" to "AI tools' personal context & capability sync layer accessed via MCP". File system stays as substrate; MCP is the front door.

## Why This, Why Now

Reference: `review` note (Maestri canvas) — 研发 2 拍板 P0 in section "5. MCP endpoint 实现方案" and "6. 垂直化判断". Competing product `neuDrive.ai` (github.com/agi-bar/neuDrive) ships exactly this experience and its MCP connector flow is the single biggest perceived gap.

A bearer-token REST API plus a hand-rolled SDK forces every consumer to:
1. Generate / paste a token
2. Hand-write request code
3. Re-do this per platform

OAuth + MCP collapses that into "paste URL → click consent in browser → call tools by name from any compatible client".

## Scope

3-week MVP, broken into committable phases.

### Week 1 — Remote MCP + OAuth closed loop ✅ SHIPPED 2026-05-08

| ID | Task | Status | Commit | Linear |
|---|---|---|---|---|
| T1.1 | OAuth discovery docs at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` (later relocated to `/api/public/.well-known/*` per EdgeSpark policy) | ✅ | `8ff7d4f` | YRZ-203 |
| T1.2 | Dynamic client registration `POST /oauth/register` | ✅ | `e0f0bd5` | YRZ-204 |
| T1.3 | Authorization code + PKCE: `GET /oauth/authorize` + `POST /oauth/authorize/consent` + `POST /oauth/token`. Consent UI is SPA route `/connect/authorize`. | ✅ | `a7800bf` (server), `e987615` (web) | YRZ-205 |
| T1.4 | Token store: D1 tables `oauth_clients`, `oauth_authorization_codes`, `oauth_tokens` (migration 0005); `oauth_tokens.source_code_id` added in 0006 for chained revoke | ✅ | `54ce505` (initial), `60d2b05` (chained-revoke schema) | YRZ-206 |
| T1.5 | MCP endpoint `POST /mcp` Streamable HTTP JSON-RPC: `initialize`, `tools/list`, `tools/call`. Unauthorized → 401 with `WWW-Authenticate: Bearer resource_metadata=...`. AGENT_TOKEN granted FULL_MCP_SCOPES for back-compat. | ✅ | `cb4f622` | YRZ-207 |
| T1.6 | First-pass tools: `list_files`, `read_file`, `write_file`, `search_files`, `create_share` | ✅ | `c309f5a` | YRZ-208 |
| T1.7 | Scope model and enforcement (`read:drive`/`write:drive`/`read:memory`/`write:memory`/`read:skills`/`write:skills`/`share:create`); `tools/list` filters; `tools/call` rejects with `invalid_scope`. | ✅ | `14d1f14` | YRZ-209 |
| T1.8 | Setup guides for Claude / Codex / Cursor; API smoke test via curl with `AGENT_TOKEN` | ✅ docs + ✅ API smoke; ⏳ IDE smoke (CEO) | `c899e52` | YRZ-210 |

**Audit + hardening commits applied within Week 1:**
- `60d2b05` `fix(server): OAuth security hardening (audit C1/C2/H1/H2/M4)` — token-exchange O(1) lookup via `<id>.<secret>` format, consent CSRF Origin check, code-reuse chained revoke, strict `approved="true"`
- `75b2305` `chore(server): tighten OAuth registration constraints (M1/M2/M3/L1)` — global cap 100, client_name length+printable, `ALLOWED_ORIGIN` var, `protocolVersion` updated
- `8e98535` `fix(server): move OAuth/MCP routes under /api/* to comply with EdgeSpark route policy` — all OAuth/MCP under `/api/public/*`
- `7dab4e5` `fix(server): enforce OAuth register rate limit and https redirect_uri` — rate-limit counter records every allowed attempt; `https://` enforced (localhost dev exception kept)

**Reviewer audits passed:** Round 1 (initial code review, 2 CRITICAL + 2 HIGH found) → fixed in `60d2b05`/`75b2305`; Round 2 (verification of fixes, all PASS, no regression).

**Live:** `https://large-gator-9215.edgespark.app/api/public/mcp` since 2026-05-08.

### Week 2 — agent-native tools + one-sentence sync (planned)

Goal: Cement the "Sync my AI skills, memory, and project context to Agent Drive" narrative. Convert from a generic file drive that *happens* to expose MCP into an opinionated AI-asset sync layer with first-class semantics for skills/memory/profiles.

| ID | Task | Files / Surfaces | Owner |
|---|---|---|---|
| T2.1 | Convention folders + dashboard surfacing. Reserve top-level paths `/skills/`, `/memory/`, `/profiles/`, `/projects/`; the dashboard renders them with explicit icons + descriptions; agent guide endpoint mentions them; convention doc enumerates expected sub-structure (e.g. `/skills/<name>/SKILL.md` + supporting files). | `docs/architecture/agent-native-folders.md` (new); `web/src/components/FolderIcon.tsx` (new); guide endpoint update | 研发 1 (server/docs) + 研发 2 (web) |
| T2.2 | `sync_profile_memory_skills` MCP tool. Accepts a manifest (paths + content) and writes into convention folders atomically. Returns a per-file outcome manifest (created/updated/skipped/conflict) so the calling LLM can summarize "synced 12 skills, 3 memories, 1 profile". | `server/src/lib/mcp-tools.ts` (extend); shared validator in `server/src/lib/sync-manifest.ts` (new) | 研发 1 |
| T2.3 | `import_skill_archive` MCP tool. Accepts base64 zip; expands into `/skills/`, validates each skill has `SKILL.md`, rejects path traversal. | `server/src/lib/mcp-tools.ts` (extend); reuses `upload` complete path | 研发 1 |
| T2.4 | `backup_agent_workspace_manifest` MCP tool. Read-only counterpart: returns a structured manifest of `/skills`, `/memory`, `/profiles` for restore on another machine. | `server/src/lib/mcp-tools.ts` (extend) | 研发 1 |
| T2.5 | Dashboard `/connect` page. Per-platform copy-pasteable setup (Claude / Codex / Cursor / Windsurf / Gemini): connector URL, scope summary, expected first-call to verify. Stays accurate by referencing `docs/setup/mcp-*.md` content. | `web/src/pages/ConnectPage.tsx` (new); `web/src/lib/mcp-platforms.ts` (new) | 研发 2 |
| T2.6 | Tool-error UX in MCP. Standardize JSON-RPC error codes: `invalid_scope` (-32603 with data), `not_found` (-32602), `conflict` (-32602), `quota_exceeded`. Documented in setup docs so connector tools render meaningful messages. | `server/src/lib/mcp-errors.ts` (new); existing tools updated | 研发 1 |
| T2.7 | Active client list + revoke in dashboard. User can see connected MCP clients (client_name, granted scopes, last used) and revoke individually. | `server/src/routes/oauth.ts` (add `GET /api/public/oauth/clients/mine`, `POST /.../:id/revoke`); `web/src/pages/ConnectedClientsPage.tsx` (new) | 研发 1 (server) + 研发 2 (web) |

**Schema migration 0007** (planned): no new tables; possibly add `oauth_clients.user_id` so users only see their own clients in T2.7. Currently every registered client is global to the project. Decide during T2.7 design.

**Conventions decisions (must lock before T2.1 starts):**
- Skill format compatibility: align with Claude Code skill manifest convention (`SKILL.md` + `references/`) so no transcoding is needed when syncing both ways. Reject other layouts at import time with explicit error.
- Memory format: Markdown files; convention is `<topic>.md` plus optional `MEMORY.md` index, mirroring Claude Code's auto-memory layout.
- Profiles: JSON or YAML (TBD). Used to capture user-style/preferences/work-context that can be replayed by other agents.
- Projects: opaque per-project subdirectory; agents bring their own structure; we don't enforce.

**Auditor reviewer pass after T2.1-T2.7 lands but before deploy.**

### Week 3 — CLI + docs + compatibility matrix

| ID | Task | Notes |
|---|---|---|
| T3.1 | CLI: `agent-drive` package (npm) supporting `auth login`, `mcp stdio` (local mode for editors that prefer stdio over remote MCP) | `cli/` (new top-level dir) |
| T3.2 | Compatibility matrix doc | `docs/setup/compatibility.md` |
| T3.3 | Verify Gemini CLI + Windsurf paths | extends T1.8 |

Browser extension explicitly **out of scope** for MVP — neuDrive's own docs note browser-extension fragility (`/tmp/neuDrive-review/docs/browser-extension.md:154-161`).

## Architecture Decisions

### A1. Two parallel token systems, not one

- `AGENT_TOKEN` (existing): long-lived, full-permission, single string; serves CLI users / REST direct callers.
- OAuth access tokens (new): short-lived (default 30min), scoped, revocable; serves MCP connectors.

Reason: collapsing them would either weaken AGENT_TOKEN (forcing scope on the all-purpose token) or make MCP tokens too long-lived. Cost of two systems is small (one extra middleware branch).

### A2. `/oauth/authorize` reuses EdgeSpark session

- User signs into EdgeSpark dashboard once (existing flow).
- `/oauth/authorize` checks session — if logged in, render consent UI directly; otherwise redirect to EdgeSpark login then back.
- Consent UI shows requested scopes in plain language ("Claude wants to read and write your files, read your skills, …"). User can decline scope-by-scope (future) or accept all.

### A3. Tokens stored as PBKDF2 hashes

- Never store raw access/refresh tokens. Hash with PBKDF2 (already used for share passwords — reuse `hashPassword` if renamed per review-#11 follow-up).
- Lookup: hash incoming token, query `WHERE access_token_hash = ?`. Index on `access_token_hash`.

### A4. PKCE is mandatory for public clients

- Reject `authorization_code` grant without `code_verifier` matching `code_challenge`.
- Public clients (no `client_secret`) MUST use PKCE.
- Confidential clients (with `client_secret`) MAY use PKCE; recommended in docs.

### A5. Tool naming: agent-native, not REST-mirrored

| Avoid | Use |
|---|---|
| `POST /files` | `write_file(path, content)` |
| `GET /shares/:id/stats` | `get_share_stats(share_id)` |
| `GET /search?q=` | `search_files(query)` |

This makes prompts read naturally: "search agent-drive for files about Q3", not "call GET /search with q=Q3".

### A6. Streamable HTTP first, SSE later

MCP spec supports both Streamable HTTP and SSE. MVP ships Streamable HTTP only — Claude / Codex / Cursor all support it. SSE deferred until a concrete client requires it (avoid Worker SSE quirks early).

## Schema Changes

### Migration 0005: `oauth_clients`

```sql
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  client_secret_hash TEXT,                -- nullable: public PKCE-only clients have no secret
  redirect_uris TEXT NOT NULL,            -- JSON array of allowed redirect_uri values
  client_name TEXT,
  scope_default TEXT,                     -- space-separated allowed scopes
  registered_at TEXT NOT NULL,
  last_used_at TEXT
);
```

### Migration 0006: `oauth_authorization_codes`

```sql
CREATE TABLE oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL,
  pkce_method TEXT NOT NULL,               -- "S256" only (reject "plain")
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,                -- 10 minutes from issue
  used_at TEXT                             -- enforce single use
);
```

### Migration 0007: `oauth_tokens`

```sql
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT UNIQUE,          -- nullable if no refresh issued
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  refresh_expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT                          -- soft delete
);
CREATE INDEX idx_oauth_tokens_access ON oauth_tokens(access_token_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_oauth_tokens_refresh ON oauth_tokens(refresh_token_hash) WHERE revoked_at IS NULL;
```

All three tables added in a single phase to keep migrations atomic; nullable where safe to keep old rows (none expected — fresh tables).

## Security Checklist

- [ ] PKCE `S256` mandatory; `plain` rejected
- [ ] `redirect_uri` exact-match against registered list (no prefix / suffix wildcards)
- [ ] `state` echoed back; client must verify
- [ ] Access token TTL ≤ 60 minutes (default 30)
- [ ] Refresh token TTL ≤ 30 days (default 7), single-use rotation
- [ ] Authorization code single-use, 10-minute TTL
- [ ] `POST /oauth/register` rate-limited per IP (reuse `rate_limits` table from YRZ-129)
- [ ] `POST /oauth/token` rate-limited on failure (reuse same)
- [ ] MCP `tools/call` enforces scope; insufficient scope → JSON-RPC error code with `invalid_scope`
- [ ] Consent UI displays scopes in plain language; never auto-grant
- [ ] Token hashes use PBKDF2 100k (existing `hashPassword`)
- [ ] All discovery and OAuth endpoints HTTPS-only (server already enforces)
- [ ] Webhook SSRF rules also apply if MCP consent ever calls back externally

## Test Plan

### Unit (server)
- PKCE: valid `S256` accepts; mismatched verifier rejects; missing verifier rejects
- Redirect URI: exact match passes; suffix difference fails
- Token hash: round-trip; tampered fails
- Scope: tool requiring `write:drive` rejected with read-only token
- Authorization code: single use; replay rejected; expired rejected

### Integration
- Full OAuth dance: register → authorize → code → access token → MCP `tools/list` → `tools/call`
- Refresh: old access expired → refresh → new access works → old access stays rejected
- Revoke: revoke endpoint → subsequent calls 401
- Scope downgrade: request `read:drive write:drive`, user accepts only `read:drive`, write tools absent from `tools/list`

### Manual smoke
- Claude desktop: add Custom Connector with URL `<YOUR_AGENT_DRIVE_URL>/api/public/mcp`, complete browser consent, list and read a file from Claude
- Codex: `codex mcp add agent-drive --url <…>` + `codex mcp login agent-drive`, run a tool
- Cursor: add to remote MCP config, run a tool

## Risks / Open Questions

1. **EdgeSpark Worker SSE support** — MVP uses Streamable HTTP only. If a future client requires SSE, revisit.
2. **SPA fallback vs. server routes** — `/oauth/authorize` and `/.well-known/*` MUST hit the Hono router, not the React SPA's catchall. Verify route ordering in `server/src/index.ts`.
3. **PKCE-only public client risk** — without `client_secret`, anyone can register a client. Mitigations: rate-limit registration; allow user to manually inspect connected clients in dashboard and revoke; never grant scope wider than user explicitly approved.
4. **neuDrive parity** — neuDrive is Go; not directly portable. Use as reference for endpoint surface and scope shape, rewrite logic in TS/Hono.
5. **AGENT_TOKEN coexistence** — middleware must distinguish: bearer with no associated `oauth_tokens` row is treated as legacy AGENT_TOKEN; bearer matching a hash in `oauth_tokens` is treated as scoped MCP token. Decide handling order in `server/src/middleware/auth.ts`.
6. **Dashboard SPA bundle size** — adding consent UI / `/connect` page should not push the bundle past current ~140KB by much. If it does, code-split.

## Out of Scope (deferred)

- FTS5 search (separate ticket from review FOLLOW-UP #1)
- `passwordVersion` auto-increment on password edit (FOLLOW-UP #2)
- Browser extension
- Full WebAuthn / passkey for dashboard login
- Linear ticket per sub-task (just create epic)

## Linear Tracking

Epic **YRZ-202** `MCP MVP — Remote MCP + OAuth + agent-native tools`. Week 1 sub-tickets YRZ-203..YRZ-210 under it. Week 2 sub-tickets to be created when plan section is locked.

## Week 1 Retrospective

### What shipped (commits in chronological order, all on `main`)

```
417c36c  docs: add MCP MVP plan + workspace scaffolding (YRZ-202)
54ce505  feat(server): token store schema (YRZ-206 T1.4)
e987615  feat(web): OAuth consent UI for MCP (YRZ-205)
14d1f14  feat(server): MCP scope model (YRZ-209 T1.7)
8ff7d4f  feat(server): OAuth discovery endpoints (YRZ-203 T1.1)
e0f0bd5  feat(server): dynamic client registration (YRZ-204 T1.2)
a7800bf  feat(server): authorization code PKCE flow (YRZ-205 T1.3 server)
cb4f622  feat(server): MCP streamable HTTP endpoint (YRZ-207 T1.5)
c309f5a  feat(server): first-pass MCP tools (YRZ-208 T1.6)
60d2b05  fix(server): OAuth security hardening (audit C1/C2/H1/H2/M4)
75b2305  chore(server): tighten OAuth registration constraints (M1/M2/M3/L1)
8e98535  fix(server): move OAuth/MCP routes under /api/* to comply with EdgeSpark route policy
c899e52  docs(setup): MCP connector setup guides (YRZ-210)
7dab4e5  fix(server): enforce OAuth register rate limit and https redirect_uri
```

13 commits across 8 implementation tickets + 4 audit/hardening + 1 docs. ~3000 LoC net. Delivered in a single working day with the multi-agent flow (研发 1 server + 研发 2 web + reviewer audit + CEO orchestration).

### What changed vs. original plan

1. **Routes moved to `/api/public/*`.** Original plan had `/.well-known/*`, `/mcp`, `/oauth/*` at origin root. EdgeSpark enforces `/api/*` prefix for all backend routes; root paths are reserved for the SPA. Mitigated by surfacing absolute URLs from the `oauth-protected-resource` discovery doc — clients still autodiscover correctly.
2. **No SSE.** Held to A6 — Streamable HTTP only.
3. **Audit added 2 schema migrations beyond the planned 0005.** Migration 0006 adds `oauth_tokens.source_code_id` (chained revoke) — discovered during reviewer Round 1.
4. **AGENT_TOKEN given full MCP scopes.** Confirmed in audit; documented in `docs/setup/mcp-*.md`.
5. **Public-IPv4 webhook URLs no longer accepted** (carryover side effect from the prior pre-MCP review pass; not scoped here).

### Open issues to track

- **Scope downgrade in consent UI** — current consent form is all-or-nothing approve. Allowing a user to drop some requested scopes before approving is a Week 2 enhancement (T2.7 candidate).
- **Connected client revoke from dashboard** — listed as T2.7.
- **Per-user oauth_clients ownership** — currently all clients are project-global. Need decision in T2.7 design.
- **`oauth_clients` table grows under cap=100** — even with cap, reaching 100 prevents new connectors. Need cleanup admin action (deferred to Week 2 along with T2.7) or automatic prune of stale-unused clients.
- **Smoke test cleanup** — 26 throwaway clients left from API smoke testing have been manually deleted via `edgespark db sql DELETE`. Future smoke runs should use a recognizable name prefix and self-cleanup.

### Lessons

- **EdgeSpark route policy** is enforced at deploy, not at dev/typecheck. Always run `edgespark deploy --dry-run` before declaring something "ready to deploy".
- **Reviewer round 1 → fix → round 2** caught two CRITICAL issues that wouldn't have been visible in a single-pass review (token-exchange O(N) PBKDF2 DoS, consent CSRF). Keep this two-pass discipline.
- **`db.batch()` and `<id>.<secret>` token format** are reusable patterns elsewhere — note in `server-patterns.md` if/when a project doc is created.
- **Author identity:** `git config --global user.name` was set to a real Chinese name; rebased the 11 unpushed commits to author `Yrzhe` before push. Lesson: set `user.name` to a public handle on every fresh machine before first commit.

## References

- `review` note (Maestri canvas), 研发 2 段 line 54-123, especially section 5
- neuDrive code locations cited by 研发 2:
  - router setup: `/tmp/neuDrive-review/internal/api/router.go:229-260`
  - OAuth handlers: `/tmp/neuDrive-review/internal/api/mcp_oauth.go:22-85`
  - HTTP MCP handler: `/tmp/neuDrive-review/internal/api/mcp_http.go:23-165`
  - setup matrix: `/tmp/neuDrive-review/docs/setup.md:111-178`
  - platform coverage: `/tmp/neuDrive-review/docs/platform-coverage-matrix.md:19-52`
- MCP spec: https://modelcontextprotocol.io
- OAuth 2.1 draft (the modern baseline): https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/
- RFC 7636 PKCE, RFC 7591 Dynamic Registration, RFC 8414 Authorization Server Metadata, RFC 9728 Protected Resource Metadata

## Implementation Flow

When work starts:
1. Branch off `main` per phase (`feat/mcp-week1`, etc.) — single PR per week
2. Schema migration commit FIRST in each phase, deployed and applied before route code
3. Update `CHANGELOG.md` per phase under a new `## [Unreleased]` block
4. After Week 1 lands, run a smoke test from Claude before opening Week 2 work
5. When the full MVP is shipped and verified, move this file to `docs/implementation/archive/`
