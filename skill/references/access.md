# Account & Access

This drive can be multi-user. If your session gets a `403 access_pending` or `403
access_suspended` on any `/api/public/v1/*` call, this is the page: it explains why,
and the two endpoints you can still reach to check in.

## When to use

- Any `/api/public/v1/*` call comes back `403 access_pending` or `403 access_suspended`
- You just signed up (or a human you're helping just signed up) and want to know
  whether the account is usable yet
- You want to attach a note or referral to a pending signup for the owner to review

## The access model

Every session (browser-authenticated) caller has an access status:

| Status | Meaning |
|---|---|
| `active` | Full access — every scoped endpoint is reachable |
| `pending` | Signed up, not yet approved — everything except `/account/*` is blocked |
| `suspended` | Access revoked by the owner — everything except `/account/*` is blocked |

**Bearer/agent tokens are never gated.** An `AGENT_TOKEN` or OAuth bearer token is
already an owner-scoped credential, so this status check only applies to browser
session callers. If you're calling the API with `Authorization: Bearer <token>`, none
of this affects you.

A new signup starts `pending`, unless its email is on the owner's allowlist, in which
case it starts `active` immediately. There is no self-service way to become `active`
from `pending` — only the owner can approve it (via the admin panel, outside this
skill's scope). `/apply` (below) only attaches an optional note; it never changes your
status.

## Endpoints (session auth only)

```
GET  /api/public/v1/account/status
Returns: { status: "active"|"pending"|"suspended", email, isAdmin }

POST /api/public/v1/account/apply
Body: { message?: string, ref?: string }
Returns: { status, email, isAdmin }
```

Both reject bearer callers with `403 session_required` — they are for the human's
browser session, not for agent tokens.

- `GET /status` is always safe to call to check in on where things stand.
- `POST /apply` attaches an optional waitlist `message` (max 500 chars) and/or `ref`
  referral code (max 128 chars) to your `pending` row, for the owner to see when
  reviewing the waitlist. Omitting a field leaves its stored value untouched; sending
  an empty/whitespace string clears it. Calling `/apply` when already `active` is a
  harmless no-op — it still returns your current status.

## The 403s

| Status | Code | Meaning | What to do |
|---|---|---|---|
| 403 | `access_pending` | Signed up, awaiting owner approval | Call `POST /apply` once with a short message if useful, then wait — there is nothing else to retry until the owner approves |
| 403 | `access_suspended` | Owner revoked access | Nothing to retry — this is a deliberate owner decision |

Neither code means "try again" or "your token is wrong" — both mean the account
itself isn't cleared yet (or no longer is). Don't loop-retry these; surface the status
and, for `access_pending`, the fact that it's awaiting a human decision.

## Allowlist vs. waitlist

- **Allowlist**: a set of emails the owner pre-approved. Matching it makes a brand-new
  signup start `active` instead of `pending` — no waiting required.
- **Waitlist**: every `pending` account, implicitly. There's no separate signup step —
  landing on `pending` *is* being on the waitlist. `POST /apply`'s optional
  `message`/`ref` just annotate that pending row for the owner's review queue.

Managing the allowlist and approving/rejecting waitlist entries are owner-only actions
performed from the admin panel in the web UI — there is no agent-facing endpoint for
either, by design.
