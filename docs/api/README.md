# Agent Drive API Reference

This directory documents the public HTTP surface of an Agent Drive deployment.

| Doc | Audience |
|---|---|
| [`mcp.md`](./mcp.md) | Anyone integrating an AI agent over Remote MCP |
| [`oauth.md`](./oauth.md) | OAuth client implementers, security reviewers |
| [`drive-bundles.md`](./drive-bundles.md) | `adrive sync` users + anyone building versioned bundle workflows |
| [`memory.md`](./memory.md) | Agents persisting/recalling cross-session context (remember/recall) |
| [`spaces.md`](./spaces.md) | Sharing existing files/folders/memory by reference with other users (roles, live-edit consequence, MCP tools) plus the public commons every active user implicitly belongs to |
| [`access.md`](./access.md) | Session callers hitting `403 access_pending`/`access_suspended` — status, waitlist apply, the access gate |
| [`registration.md`](./registration.md) | Agents helping a human with no account yet sign up — mint an intent, hand off a link, never touch the password |
| [`agent-card.md`](./agent-card.md) | Peers discovering this deployment's identity, key, and capabilities |
| [`tokens.md`](./tokens.md) | Owners minting/revoking scoped bearer tokens for third-party agents |
| [`peering.md`](./peering.md) | Drive-to-Drive contacts, signed inbox delivery, published bundle subscriptions |
| [`webhooks.md`](./webhooks.md) | Register signed HTTP callbacks for drive events (root-path tokens only) |
| [`activity.md`](./activity.md) | Read the drive's activity log (audit trail; path-scoped view) |
| [`skill.md`](./skill.md) | Fetch the installable skill (manifest + files) with honest status — for a self-updater |
| [Compatibility matrix](../setup/compatibility.md) | Anyone deciding which client to use |
| Setup guides ([Claude](../setup/mcp-claude.md), [Codex](../setup/mcp-codex.md), [Cursor](../setup/mcp-cursor.md), [Gemini](../setup/mcp-gemini.md), [Windsurf](../setup/mcp-windsurf.md)) | End users wiring an IDE/agent |

> Easiest onboarding path is the in-app wizard at `<YOUR_AGENT_DRIVE_URL>/connect` — it auto-detects the right URL and emits per-IDE config snippets.

## Base URL

Every documented endpoint lives under your deployment origin:

```text
<YOUR_AGENT_DRIVE_URL>/api/public/...
```

`<YOUR_AGENT_DRIVE_URL>` is the EdgeSpark origin assigned to your deployment, e.g. `<YOUR_AGENT_DRIVE_URL>`. To find yours, see [Finding your Agent Drive URL](../setup/mcp-claude.md#finding-your-agent-drive-url).

The four public surfaces:

| Path | Purpose |
|---|---|
| `/api/public/mcp` | MCP JSON-RPC endpoint (the main integration surface) |
| `/api/public/.well-known/oauth-protected-resource` | RFC 9728 protected-resource metadata |
| `/api/public/.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |
| `/api/public/oauth/{register,authorize,token,authorize/consent}` | OAuth 2.1 endpoints |

## Authentication

Two paths into the same scope-checked surface (scopes are enforced on MCP tools and on every REST `/api/public/v1/*` endpoint — capability scopes centrally in middleware, path scopes per resolved target):

1. **OAuth 2.1 access token** — primary path for IDE integrations. Bearer token obtained via dynamic client registration (RFC 7591) + authorization-code-with-PKCE grant (RFC 7636). Scope is whatever the user approved on the consent screen. See [`oauth.md`](./oauth.md).
2. **`AGENT_TOKEN` bypass** — secondary path for self-hosted single-user mode. Set `AGENT_TOKEN` as an EdgeSpark secret; pasting it as `Authorization: Bearer <token>` skips OAuth. Defaults to `read:drive write:drive share:create read:memory write:memory path:/`; set the optional `AGENT_TOKEN_SCOPES` var to narrow it further. Malformed or unsupported configured scopes fail closed for both MCP tools and REST endpoints.

In both cases, the token is sent as `Authorization: Bearer <token>` on every MCP request.

> **Single-owner by default, multi-user access model underneath.** Set the `OWNER_EMAIL` var to the owner's login email to arm ownership resolution; leaving it unset keeps the legacy single-user behavior (any authenticated session is trusted, no access gate). Once armed, non-owner **browser sessions** are confined by access status rather than rejected outright — see [`access.md`](./access.md) for the `active`/`pending`/`suspended` states, the `403 access_pending` / `403 access_suspended` gate, and the two session-only `/account/*` endpoints. User-bound bearer tokens (OAuth / minted drive tokens) are gated by access status too — suspending a user immediately breaks their existing tokens. Only the legacy install-wide `AGENT_TOKEN` on an `OWNER_EMAIL`-unset deployment is ungated, having no principal to gate. Public sign-up is **live** (`configs/auth-config.yaml → disableSignUp: false`, `requireEmailVerification: true`); new accounts land on the waitlist as `pending` until the owner approves them, unless their email is allowlisted.

## Versioning

There is currently a single live version. Breaking changes will move to `/api/public/v2/...` and the existing `/api/public/...` surface will be frozen. Until then, treat the current surface as the stable v1.

## Rate limits

| Endpoint | Limit |
|---|---|
| `POST /api/public/oauth/register` | 20/hour/IP, plus a global cap of 100 registered clients |
| `POST /api/public/oauth/token` | inherits per-client throttling |
| `POST /api/public/mcp` | no explicit per-call limit; tools enforce their own resource limits (e.g. `list_files` returns max 200 entries per call) |

D1 is the persistent rate-limit store, so limits hold across cold starts and replicas.

## Error format

OAuth endpoints follow [RFC 6749 §5.2](https://datatracker.ietf.org/doc/html/rfc6749#section-5.2):

```json
{
  "error": "invalid_grant",
  "error_description": "code expired or already used"
}
```

MCP errors follow JSON-RPC 2.0:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "invalid_scope:write:drive"
  }
}
```

See [`mcp.md`](./mcp.md#errors) for the full code table.

## Discovery

Any spec-compliant MCP client can autodiscover the OAuth endpoints from the protected-resource metadata. Hitting an unauthenticated MCP request:

```http
POST /api/public/mcp HTTP/1.1
```

returns:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="<YOUR_AGENT_DRIVE_URL>/api/public/.well-known/oauth-protected-resource"
```

Per [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728), the client follows that URL to find the authorization server, then runs a standard OAuth 2.1 dance.

## Reference

- [MCP Spec](https://modelcontextprotocol.io/specification/)
- [RFC 6749 — OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc6749)
- [RFC 7591 — Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
- [RFC 7636 — PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
- [RFC 8414 — Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414)
- [RFC 9728 — Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
