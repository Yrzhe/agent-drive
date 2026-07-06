# Scoped Drive Tokens

Owner-minted bearer tokens with narrowed capabilities and an optional path prefix — the low-friction alternative to the OAuth dance when handing access to a third-party agent. Unblocked by the REST scope enforcement work (#3): the scopes on these tokens are enforced on every MCP tool and REST endpoint.

## Security model

- **Minting, listing, and revoking are session-only.** All three endpoints reject bearer-authenticated callers with `403 session_required`, so a token can never mint further tokens (no privilege escalation). The owner uses the **Scoped drive tokens** panel on `/connect`.
- Tokens are stored in the `oauth_tokens` table under the synthetic client id `drive_token` (id prefix `dtk_`), hashed exactly like OAuth access tokens, and authenticate through the same `authenticateMcpBearer` path — expiry and `revoked_at` are honored everywhere immediately.
- The plaintext token (`dtk_<id>.<secret>`) is returned exactly once at mint time.

## Endpoints (session auth required)

| Method | Endpoint | Body / Params | Returns |
|---|---|---|---|
| POST | `/api/public/v1/tokens` | `{ label?, scopes: string[], pathPrefix?, expiresInDays? }` | `201 { token, hint, tokenInfo }` |
| GET | `/api/public/v1/tokens` | `?limit=100&offset=0` (max 500) | `{ tokens: [...], limit, offset }` |
| DELETE | `/api/public/v1/tokens/:id` | — | `{ revoked }` |

- `scopes`: non-empty subset of `read:drive write:drive share:create read:memory write:memory`. `read:skills`/`write:skills` and raw `path:` entries are rejected — use `pathPrefix`.
- `pathPrefix`: absolute path (`/handoffs`) or canonical scope form (`path:/handoffs/*`); same grammar as OAuth path scopes (no `..`, `//`, globs, or whitespace — scope strings are space-delimited). Applies to file/folder/share/bundle operations; memory has no paths.
- `expiresInDays`: 1–365, default 90.
- `label`: display name, max 64 chars.

## Token object

```json
{
  "id": "dtk_...",
  "label": "research-agent",
  "scopes": ["read:drive", "path:/handoffs/*"],
  "createdAt": "2026-07-05T14:00:00.000Z",
  "expiresAt": "2026-10-03T14:00:00.000Z",
  "revokedAt": null,
  "expired": false
}
```

## Activity events

`token.minted` and `token.revoked` are logged (metadata: label, scopes, expiry — never the secret).
