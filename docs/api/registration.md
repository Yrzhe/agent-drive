# Agent-Native Registration Hand-off

Public, unauthenticated endpoints that let a **recipient's agent** kick off account
creation on a human's behalf and hand back a link for that human to finish in their own
browser. Part ③ of the multi-tenancy work (#30) — see `CHANGELOG.md` for the full
rollout history.

## THE SECURITY BOUNDARY

This hand-off is deliberately split so the parts a human must control never pass
through an agent:

| Step | Who does it | Where |
|---|---|---|
| Start the intent (`email`, `name?`, `ref?`) | The agent | `POST /api/public/register/start` |
| Open the hand-off link | The human | Their browser |
| Set a password | The human | `/signup?token=...` page — Better Auth's `signUp.email()` directly |
| Click the verification link | The human | Their email client |

The agent supplies only `email`/`name`/`ref` — plain metadata — and receives back a
`handoffUrl`. **It never receives, generates, stores, or transmits a password.** A
`password` field sent to `/start` is silently ignored (there is no field for it in
`RegistrationIntentInput`); the request body is parsed with an explicit allowlist of
`email`/`name`/`ref`, so nothing else in the body reaches storage. Session cookies and
the email-verification link are entirely Better Auth's, scoped to the human's browser —
this API surface never sees or issues either.

## Endpoints (public, no auth)

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| POST | `/api/public/register/start` | `{ email, name?, ref? }` | `201 { handoffUrl, expiresAt }` |
| GET | `/api/public/register/intent/:token` | — | `200 { email, name, ref }` or `404 intent_not_found` |

### `POST /start`

- No authentication — this is intentionally reachable by an unregistered caller (that's
  the point: the human doesn't have an account yet).
- **Rate-limited by caller IP**: 10 calls/hour (`server/src/lib/rate-limit.ts`, D1-backed
  so the limit holds across cold starts). Every call counts toward the limit, not just
  failures — the endpoint materializes a DB row per call, so it must not be usable as a
  free write amplifier. Over the limit: `429 too_many_attempts` with a `Retry-After`
  header (seconds).
- `email` is required, lowercased, and shape-validated (mirrors `routes/admin.ts`'s
  `requireValidEmail`: exactly one `@`, non-empty local/domain parts, ≤254 chars).
  `name` and `ref` are optional, trimmed, and capped at 128 characters each; an
  empty/whitespace string normalizes to `null`.
- Creates a `registration_intents` row with a 32-character `nanoid()` token and a 24h
  TTL, then returns `{ handoffUrl: "<origin>/signup?token=<token>", expiresAt }`.
  `<origin>` comes from the `ALLOWED_ORIGIN` var, falling back to the request's own
  origin.
- Opportunistic sampled cleanup (1% of calls) reaps expired/consumed rows —
  best-effort, never blocks the caller, mirrors `rate-limit.ts`'s cleanup pattern.

### `GET /intent/:token`

- No authentication, **read-only** — looking it up never consumes it. This is what the
  `/signup` web page calls to pre-fill the sign-up form.
- Returns `404 intent_not_found` for an unknown token, an expired one (past `expiresAt`),
  or one already consumed by a completed sign-up. The 404 case is intentionally
  undifferentiated — the page falls back to a blank sign-up form regardless of which of
  the three applies.

## What happens to the intent

A registration intent is **consumed exactly once**, atomically, when the account it was
minted for is first materialized in `user_access` — not when `/signup` is submitted, and
not by `GET /intent`. `resolveAccessStatus` (`server/src/lib/access.ts`) calls
`consumeIntentForEmail` (`server/src/lib/registration.ts`) on the `userAccess` INSERT
branch only:

- Looks up the newest unexpired, unconsumed intent for the account's email (matched
  lowercased — intents are always stored lowercased).
- Atomically stamps `consumedAt` via a conditional `UPDATE ... WHERE consumedAt IS NULL
  AND expiresAt > now`, the same race-safe pattern as
  `public-shares.ts`'s `incrementDownloadCountOrThrow` — two racing materializations
  can never both "win" the same intent.
- On success, donates the intent's `ref` into the new `user_access` row's `referredBy`
  column. **This only happens on first materialization** — an already-existing
  `user_access` row is never re-stamped, so a later `/start` call for the same email
  after the account already exists has no effect on that account.

This means the intent's fate is tied to *when the human's account row is first seen by
the access-resolution path*, not to the `/signup` form submission itself. In practice
those happen back-to-back (sign-up → first authenticated request → access resolution),
but they are two separate steps.

## `ref` — referral, not access

`ref` is free-text metadata (max 128 chars) an inviting agent can attach. It is copied
once into `user_access.referredBy` for the **owner's waitlist review** — visible from
the admin panel, nothing more.

**`ref` never grants access and is never evaluated against anything.** The
active-vs-pending decision is made purely by matching the account's email against the
owner's allowlist (see `access.md`) — a referral code carries zero weight in that
decision, by design. There is no way to use `ref` to bypass or influence approval.

## Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `validation_error` | `email` missing/malformed, or `name`/`ref` not a string / over 128 chars |
| 404 | `intent_not_found` | Token unknown, expired (24h TTL), or already consumed |
| 429 | `too_many_attempts` | More than 10 `/start` calls from the same IP within an hour |

## Relationship to the access model

Registration hand-off (this doc) only gets a human as far as a verified Better Auth
account. What happens next — `active` immediately vs. `pending` on the waitlist — is
entirely [`access.md`](./access.md)'s territory: allowlisted email → `active`,
otherwise → `pending` awaiting owner approval. This module adds no new way to become
`active`; it exists purely to make starting the sign-up agent-driven and to carry an
optional referral note along for the ride.

`/api/public/v1/admin/*` (approving/rejecting waitlist entries, managing the
allowlist) is, as with `access.md`, **deliberately excluded from every agent-facing
surface** (this doc, `llms.txt`, the skill, `/api/public/guide`) — owner-only tooling.
