# Account & Access

Multi-user access status for **session (browser) callers**, plus the two endpoints
that stay reachable when a session isn't `active` yet. Part ② of the multi-tenancy
work (#30) — see `CHANGELOG.md` for the full rollout history.

## Access status

Every session-authenticated user resolves to one of:

| Status | Meaning |
|---|---|
| `active` | Full access — every scoped endpoint reachable |
| `pending` | Signed up, not yet approved by the owner |
| `suspended` | Access revoked by the owner |

A brand-new signup starts `pending`, unless its email matches an entry on the owner's
allowlist, in which case it starts `active` immediately. Once materialized, the stored
status is authoritative — it is never re-derived or silently flipped by a later
allowlist change (see `resolveAccessStatus` in `server/src/lib/access.ts`). Approving,
rejecting, or suspending an account is exclusively an owner (admin-panel) action; there
is no self-service or agent-facing path to change your own status.

## Access-gate behavior

`requireActiveAccess` (`server/src/middleware/access-gate.ts`) runs on every
`/api/public/v1/*` request, after auth resolution:

- **Bearer/agent token callers are never gated.** A bearer token (`AGENT_TOKEN` or a
  minted/OAuth drive token) is already an owner-scoped credential — there is no
  per-status check to apply to it.
- **Session callers** are checked against their access status: `active` passes
  through; `pending` and `suspended` are rejected on every route **except**
  `/account/*` and `/admin/*`, which stay reachable so a pending/suspended user can
  always see their own status (and, for `/admin/*`, so the owner check itself is never
  blocked by a stale `user_access` row).

## Endpoints (session auth only)

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| GET | `/api/public/v1/account/status` | — | `{ status, email, isAdmin }` |
| POST | `/api/public/v1/account/apply` | `{ message?, ref? }` | `{ status, email, isAdmin }` |

Both endpoints require `requireSessionAuth` — a bearer-authenticated caller gets
`403 session_required` (the same pattern used by token minting and contact
management; see `tokens.md`).

- **`GET /status`** calls `resolveAccessStatus`, which also materializes the caller's
  `user_access` row on first call (idempotent — a re-call never re-derives an
  already-decided status).
- **`POST /apply`** attaches an optional waitlist `message` (≤500 chars) and/or `ref`
  referral code (≤128 chars) to the caller's `pending` row. Fields are three-way
  parsed: omitted leaves the stored value untouched, an explicit empty/whitespace
  string clears it, a non-empty string sets it — so a follow-up `/apply` call without
  `message` never wipes one sent earlier. **It never grants access itself** — calling
  it while already `active` is a harmless no-op that just echoes the current status.

## Error codes

| Status | Code | Meaning |
|---|---|---|
| 403 | `access_pending` | Session's account is awaiting owner approval |
| 403 | `access_suspended` | Session's access was revoked by the owner |
| 403 | `session_required` | `/account/*` called with a bearer token instead of a browser session |
| 400 | `validation_error` | `/apply` body: `message`/`ref` not a string, or over the length cap |

## Allowlist vs. waitlist

- **Allowlist** — emails the owner pre-approved; matching one auto-activates a new
  signup (`active` instead of `pending`).
- **Waitlist** — every `pending` account, implicitly; there is no separate signup
  step. `/apply`'s optional `message`/`ref` just annotate that row for the owner's
  review queue.

Both the allowlist and waitlist review queue are managed exclusively from the owner's
admin panel (`/api/public/v1/admin/*`, session-only). Those admin endpoints are
**deliberately excluded from every agent-facing surface** (this doc, `llms.txt`, the
skill, `/api/public/guide`) — they are owner tooling, not something an agent should
discover or call.
