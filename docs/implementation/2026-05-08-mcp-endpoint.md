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

### Week 1 — Remote MCP + OAuth closed loop

| ID | Task | Files / Surfaces |
|---|---|---|
| T1.1 | OAuth discovery docs at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` | `server/src/routes/oauth-discovery.ts` (new) |
| T1.2 | Dynamic client registration `POST /oauth/register` (RFC 7591 minimum) | `server/src/routes/oauth.ts` (new) |
| T1.3 | Authorization code + PKCE: `GET /oauth/authorize` (consent UI, EdgeSpark session reused), `POST /oauth/token` | same `oauth.ts`; consent UI = small server-rendered HTML or SPA route `/connect/authorize` |
| T1.4 | Token store: D1 tables `oauth_clients`, `oauth_authorization_codes`, `oauth_tokens` | `server/src/defs/db_schema.ts` + migration 0005/0006/0007 |
| T1.5 | MCP endpoint `POST /mcp` Streamable HTTP JSON-RPC: `initialize`, `tools/list`, `tools/call`. Unauthorized → 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"` | `server/src/routes/mcp.ts` (new) + `server/src/lib/mcp.ts` (handler) |
| T1.6 | First-pass tools: `list_files`, `read_file`, `write_file`, `search_files`, `create_share` | `server/src/lib/mcp-tools.ts` (new) |
| T1.7 | Scope model: `read:drive` / `write:drive` / `read:memory` / `write:memory` / `read:skills` / `write:skills` / `share:create`. `tools/list` filters by token scope; `tools/call` enforces. | `server/src/lib/mcp-scopes.ts` (new) |
| T1.8 | Smoke test on Claude Custom Connector + Codex `codex mcp add --url` + Cursor remote MCP. Capture working configs in docs. | `docs/setup/mcp-claude.md`, `mcp-codex.md`, `mcp-cursor.md` |

### Week 2 — agent-native tools + one-sentence sync

| ID | Task | Notes |
|---|---|---|
| T2.1 | Conventional folders: `/skills/`, `/memory/`, `/profiles/`, `/projects/`. Add markers in dashboard, document expected structure. | `docs/architecture/agent-native-folders.md` |
| T2.2 | `sync_profile_memory_skills` tool. Internal: client-driven push of file blobs into convention folders, returns manifest. | enables "sync everything to agent-drive" UX |
| T2.3 | `import_skill_archive` (zip / tar.gz upload) | reuses upload route under the hood |
| T2.4 | `backup_agent_workspace_manifest` — read manifest of current logical workspace | optional convenience |
| T2.5 | Dashboard `/connect` page: per-platform setup snippets (Claude / Codex / Cursor / Windsurf / Gemini) | `web/src/pages/ConnectPage.tsx` |

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
- Claude desktop: add Custom Connector with URL `https://large-gator-9215.edgespark.app/mcp`, complete browser consent, list and read a file from Claude
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

Create one epic for this plan; each `T#.#` row above maps to one ticket under it. Suggested epic title: `MCP MVP — Remote MCP + OAuth + agent-native tools`. Link this plan from the epic description.

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
