# Agent Drive API Reference

This directory documents the public HTTP surface of an Agent Drive deployment.

| Doc | Audience |
|---|---|
| [`mcp.md`](./mcp.md) | Anyone integrating an AI agent over Remote MCP |
| [`oauth.md`](./oauth.md) | OAuth client implementers, security reviewers |
| Setup guides ([Claude](../setup/mcp-claude.md), [Codex](../setup/mcp-codex.md), [Cursor](../setup/mcp-cursor.md)) | End users wiring an IDE/agent |

> Easiest onboarding path is the in-app wizard at `<YOUR_AGENT_DRIVE_URL>/connect` — it auto-detects the right URL and emits per-IDE config snippets.

## Base URL

Every documented endpoint lives under your deployment origin:

```text
<YOUR_AGENT_DRIVE_URL>/api/public/...
```

`<YOUR_AGENT_DRIVE_URL>` is the EdgeSpark origin assigned to your deployment, e.g. `https://large-gator-9215.edgespark.app`. To find yours, see [Finding your Agent Drive URL](../setup/mcp-claude.md#finding-your-agent-drive-url).

The four public surfaces:

| Path | Purpose |
|---|---|
| `/api/public/mcp` | MCP JSON-RPC endpoint (the main integration surface) |
| `/api/public/.well-known/oauth-protected-resource` | RFC 9728 protected-resource metadata |
| `/api/public/.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |
| `/api/public/oauth/{register,authorize,token,authorize/consent}` | OAuth 2.1 endpoints |

## Authentication

Two paths into the same scope-checked surface:

1. **OAuth 2.1 access token** — primary path for IDE integrations. Bearer token obtained via dynamic client registration (RFC 7591) + authorization-code-with-PKCE grant (RFC 7636). Scope is whatever the user approved on the consent screen. See [`oauth.md`](./oauth.md).
2. **`AGENT_TOKEN` bypass** — secondary path for self-hosted single-user mode. Set `AGENT_TOKEN` as an EdgeSpark var; pasting it as `Authorization: Bearer <token>` grants `FULL_MCP_SCOPES` and skips OAuth entirely. Useful for personal automations and CI.

In both cases, the token is sent as `Authorization: Bearer <token>` on every MCP request.

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
    "code": -32602,
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
