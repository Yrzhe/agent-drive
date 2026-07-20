# OAuth 2.1 Reference

Agent Drive implements OAuth 2.1 for MCP clients. Public clients (no `client_secret`) are supported via mandatory PKCE S256.

Endpoint base:

```text
<YOUR_AGENT_DRIVE_URL>/api/public
```

## Discovery

### `GET /.well-known/oauth-protected-resource` (RFC 9728)

Tells MCP clients which authorization server protects this resource.

```bash
curl <YOUR_AGENT_DRIVE_URL>/api/public/.well-known/oauth-protected-resource
```

Response:

```json
{
  "resource": "<YOUR_AGENT_DRIVE_URL>/api/public/mcp",
  "authorization_servers": [
    "<YOUR_AGENT_DRIVE_URL>/api/public/.well-known/oauth-authorization-server"
  ],
  "bearer_methods_supported": ["header"],
  "scopes_supported": [
    "read:drive", "write:drive",
    "read:memory", "write:memory",
    "share:create"
  ]
}
```

### `GET /.well-known/oauth-authorization-server` (RFC 8414)

Authorization server metadata.

Response:

```json
{
  "issuer": "<YOUR_AGENT_DRIVE_URL>/api/public/.well-known/oauth-authorization-server",
  "authorization_endpoint": "<YOUR_AGENT_DRIVE_URL>/api/public/oauth/authorize",
  "token_endpoint": "<YOUR_AGENT_DRIVE_URL>/api/public/oauth/token",
  "registration_endpoint": "<YOUR_AGENT_DRIVE_URL>/api/public/oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
  "scopes_supported": [...]
}
```

## Endpoints

### `POST /oauth/register` — Dynamic Client Registration (RFC 7591)

Registers a public OAuth client. No authentication required. Rate-limited.

Request:

```json
{
  "client_name": "my-ide",
  "redirect_uris": ["https://example.com/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "read:drive write:drive share:create"
}
```

Validation rules:

- `client_name`: 1–64 printable ASCII characters.
- `redirect_uris`: array, at least 1 entry — no maximum. Each must be `https://...` **except** `http://localhost:*` and `http://127.0.0.1:*` (allowed for local dev / desktop apps per IETF guidance).
- `grant_types` / `response_types`: not read from the request body — whatever the client sends for these two fields is ignored. The server always responds with `grant_types: ["authorization_code", "refresh_token"]` and `response_types: ["code"]`.
- `scope`: space-separated; unknown/malformed scope tokens are silently dropped during normalization (the effective set is returned in the response). An all-invalid or empty scope falls back to `read:drive`.

Rate limits:

- 20 registrations per hour per IP.
- Global cap of 100 registered clients (returns `429 client_limit_exceeded` past the cap).

Response (201):

```json
{
  "client_id": "ad_xxxxxxxxxxxxxxxx",
  "client_id_issued_at": 1746700000,
  "client_name": "my-ide",
  "redirect_uris": ["..."],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "scope": "read:drive write:drive share:create",
  "token_endpoint_auth_method": "none"
}
```

No `client_secret` is issued — public clients only.

### `GET /oauth/authorize`

Begins the authorization-code flow.

Required query params:

| Param | Notes |
|---|---|
| `client_id` | From `/oauth/register` |
| `redirect_uri` | Must exactly match one of the registered URIs |
| `response_type` | `code` |
| `state` | Opaque CSRF token; echoed back |
| `code_challenge` | PKCE S256 challenge (mandatory) |
| `code_challenge_method` | `S256` |
| `scope` | Space-separated; must be subset of registered scope |

Errors: `400 invalid_request` — missing `code_challenge` or `code_challenge_method` is not `S256`. `400 unsupported_response_type` — `response_type` is not `code`. `400 invalid_client` — unknown `client_id`. `400 invalid_redirect_uri` — `redirect_uri` doesn't match a registered URI.

Behavior:

1. If the user has no EdgeSpark session, redirects to login then back.
2. Renders the consent UI (SPA route `/connect/authorize`) showing requested scopes.
3. On `approved=true` consent submission, generates an authorization code bound to `code_challenge`, `redirect_uri`, `scope`, and the user.
4. 302 redirects to `redirect_uri?code=...&state=...`.

### `POST /oauth/authorize/consent`

Internal endpoint hit by the consent UI when the user approves or denies. Origin-checked (CSRF). Body:

```json
{
  "request_id": "<from authorize>",
  "approved": "true",
  "scope": "read:drive write:drive"
}
```

- `Origin` header is required and must equal the deployment origin (or `ALLOWED_ORIGIN`). Missing/mismatched Origin → `403 csrf_error`.
- `approved` must be the literal string `"true"` to grant. Any other value (including missing) denies.
- `scope` may be a strict subset of what the client requested.
- Same PKCE requirement as `/authorize`: missing `code_challenge` or a non-`S256` `code_challenge_method` → `400 invalid_request`. Unknown `client_id` → `400 invalid_client`; mismatched `redirect_uri` → `400 invalid_redirect_uri`.

### `POST /oauth/token`

Exchanges a code or refresh token for an access token.

#### Grant: `authorization_code`

Request (form-encoded or JSON):

```json
{
  "grant_type": "authorization_code",
  "client_id": "ad_...",
  "code": "<id>.<secret>",
  "redirect_uri": "https://example.com/callback",
  "code_verifier": "<PKCE verifier>"
}
```

Behavior:

- The code is validated by splitting on `.` — `<id>` does an O(1) lookup, the secret is verified against a PBKDF2 hash.
- If the code has already been used, **all tokens issued from that code are revoked** (chained revocation per `oauth_tokens.source_code_id`). This deters replay attacks.
- PKCE `code_verifier` must hash (SHA-256, base64url) to the stored `code_challenge`.

Response:

```json
{
  "access_token": "<id>.<secret>",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token": "<id>.<secret>",
  "scope": "read:drive write:drive"
}
```

#### Grant: `refresh_token`

```json
{
  "grant_type": "refresh_token",
  "client_id": "ad_...",
  "refresh_token": "<id>.<secret>",
  "scope": "read:drive"
}
```

- New `access_token` (and rotated `refresh_token`) issued.
- The refresh **reissues the original grant's scopes**. A narrower `scope` request parameter is not currently applied — the rotated token keeps the original scopes. (To reduce scope, mint a new token or re-run the authorization flow.)

#### Errors

| `error` | When |
|---|---|
| `too_many_attempts` | Rate limit exceeded (429) |
| `invalid_client` | `client_id` not registered, or `client_secret` invalid |
| `invalid_grant` | Code/refresh token not found, expired, already used, PKCE mismatch, or `redirect_uri` mismatch |
| `unsupported_grant_type` | Anything other than `authorization_code` or `refresh_token` |

Note: refresh does not currently support narrowing scope via the `scope` request parameter — see "Grant: `refresh_token`" above.

### `GET /oauth/clients/:clientId`

Public, no authentication. Returns a registered client's public metadata.

Response (200):

```json
{
  "client_id": "ad_...",
  "client_name": "my-ide",
  "redirect_uris": ["https://example.com/callback"],
  "scope": "read:drive write:drive share:create",
  "token_endpoint_auth_method": "none"
}
```

`token_endpoint_auth_method` is derived from whether the client has a stored secret hash (`"client_secret_post"` if so, else `"none"`) — it is not stored as its own field. `client_secret` is never returned.

Errors: `400 invalid_request` — missing `clientId` path param. `404 client_not_found` — no client with that id.

## Token format

Both authorization codes and tokens use the `<id>.<secret>` format:

- `<id>` is a non-secret short identifier used for O(1) DB lookup.
- `<secret>` is hashed server-side via PBKDF2 (100k iterations).
- The full string is sent on the wire — clients should treat it as opaque.

This avoids the O(N) PBKDF2 scan that would be required if tokens were stored only by hash.

## Scope vocabulary

Authoritative list lives in `server/src/lib/mcp-scopes.ts`.

### Capability scopes

| Scope | Description |
|---|---|
| `read:drive` | Read files and folders in Agent Drive |
| `write:drive` | Create and update files and folders |
| `read:memory` | Read agent memories (`recall`/`list_memories`, `GET /v1/memory*`) |
| `write:memory` | Create/update/delete agent memories (`remember`/`forget`, `POST/DELETE /v1/memory*`) |
| `share:create` | Create share links for files and folders |

### Path-prefix scopes

Limit a token's blast radius to a subtree of the drive. Grammar:

```text
path:<absolute-prefix>/*     # e.g. path:/skills/* or path:/memory/*
path:/                       # entire drive (default if omitted)
```

Tokens may carry zero or more `path:*` scopes. Enforcement rule applied to every file/folder operation:

- **No `path:*` scope on token** → any path allowed (backwards compat).
- **One or more `path:*` scopes** → the target path must equal OR be a descendant of at least one granted prefix; otherwise the tool call returns `invalid_scope:path:<target>`.
- `list_files` automatically filters its result to paths the token can see. `search_files` does the same — a token scoped to `/skills/*` will not surface hits from `/memory/`.

Grammar rules:

- Prefix must start with `/`. Trailing `/*` is stripped during normalization; `path:/skills` and `path:/skills/*` are equivalent.
- No `..`, no `//`, no `*` anywhere except the trailing `/*`, no control characters.
- Server canonicalizes to either `path:/` (root) or `path:/<prefix>/*` before persisting.

Examples:

```text
# Claude Desktop limited to skills only
scope=read:drive write:drive path:/skills/*

# A throwaway agent that can only write to /scratch
scope=write:drive path:/scratch/*

# Read-only audit token scoped to memory + skills
scope=read:drive path:/memory/* path:/skills/*
```

The CLI's `--scope` flag accepts these tokens too (`adrive login --url ... --scope "read:drive write:drive path:/skills/*"`). Unknown path syntax is rejected client-side with the allowed grammar.

## Security notes

- **Public clients only.** Anyone can register. Mitigations: rate-limit + global cap, scope strictly bound to user consent, dashboard-driven revoke (planned).
- **PKCE S256 mandatory.** `plain` is rejected.
- **Origin check on consent.** Prevents CSRF on `/oauth/authorize/consent` from third-party origins.
- **HTTPS-only redirect_uris**, with localhost/127.0.0.1 exception for development.
- **Chained revoke on code reuse.** Single-use codes; replay invalidates all derived tokens.
- **Tokens are PBKDF2-hashed** server-side; the DB never stores plaintext secrets.

## See also

- [`mcp.md`](./mcp.md) — how to use the access token once you have one
- [`README.md`](./README.md) — base URL, authentication overview, error format
- [RFC 6749 — OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc6749)
- [RFC 7591 — Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
- [RFC 7636 — PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
- [RFC 8414 — Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414)
- [RFC 9728 — Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
