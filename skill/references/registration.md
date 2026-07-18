# Registration Hand-off

Use this when you're helping a human who doesn't have an account on this drive yet.
You (the agent) can kick off their sign-up and hand them a ready-to-use link — but you
never see their password, and you never complete the sign-up for them.

## When to use

- A human you're working with (the recipient of a share, a teammate, anyone) needs an
  account on this drive and doesn't have one
- You want to pre-fill their email/name on the sign-up form and optionally tag the
  request with a referral code
- You are NOT trying to sign up yourself — this drive has no per-agent accounts; you
  authenticate with a bearer token (see `access.md` / `api-reference.md`), not a
  password

## THE SECURITY BOUNDARY (read this first)

This hand-off is deliberately split so the parts a human must control never pass
through an agent:

| Step | Who does it | Where |
|---|---|---|
| Start the intent (email, name, ref) | **You** (the agent) | `POST /api/public/register/start` |
| Open the hand-off link | **The human** | Their browser |
| Set a password | **The human** | `/signup?token=...` page |
| Click the verification link | **The human** | Their email client |

You supply only `email`, an optional `name`, and an optional `ref` — plain metadata.
You get back a URL, which you pass to the human. **You never receive, generate,
store, or transmit a password.** The `/start` endpoint silently ignores a `password`
field if one is sent — there is no way to smuggle one through. Session cookies and the
email-verification link are entirely Better Auth's, in the human's browser; this API
never exposes either to you.

## The flow

1. **You call `POST /api/public/register/start`:**
   ```
   POST /api/public/register/start
   Body: { email: string, name?: string, ref?: string }
   Returns: 201 { handoffUrl: "https://.../signup?token=...", expiresAt }
   ```
   - No auth required — this is a public endpoint.
   - Rate-limited by caller IP (10 calls/hour); over the limit returns `429
     too_many_attempts` with a `Retry-After` header.
   - `email` is required (validated + lowercased); `name` and `ref` are optional
     (capped at 128 characters each).
   - The intent expires in 24 hours and is single-use — a completed sign-up consumes
     it; a second `/signup` visit with the same token afterward falls back to a blank
     form.

2. **You give the human the `handoffUrl`.** Paste it to them as-is — it's a normal
   `/signup?token=...` link on this drive's own web app. There's nothing else to
   relay; you don't need to explain the token internals.

3. **The human opens it in a browser.** The `/signup` page calls `GET
   /api/public/register/intent/{token}` itself to pre-fill their email (and name, if
   you supplied one) — you don't need to call this yourself unless you want to confirm
   the intent is still alive before handing over the link. It's read-only and never
   consumes the intent, so calling it doesn't burn the human's one shot at signing up.

4. **The human sets a password and submits.** This goes straight to Better Auth's
   `signUp.email()` in their browser — never through `/register/*`, never through you.

5. **The human clicks the verification email.** Also entirely outside this API.

6. **The access model takes over.** Once verified, the account is routed per
   `references/access.md`: an allowlisted email activates immediately; otherwise the
   account lands on the waitlist (`pending`) awaiting the owner's approval. Your `ref`
   (if supplied) is now attached to that waitlist entry as `referredBy` — a note for
   the owner, not a magic word that grants access.

## Endpoints

```
POST /api/public/register/start
Body: { email: string, name?: string, ref?: string }
Returns: 201 { handoffUrl: string, expiresAt: string }
No auth. Rate-limited (10/hour/IP -> 429 too_many_attempts).
```

```
GET /api/public/register/intent/{token}
Returns: 200 { email: string, name: string|null, ref: string|null }
         404 intent_not_found  (unknown, expired, or already-consumed token)
No auth. Read-only — never consumes the intent.
```

## Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `validation_error` | `email` missing/malformed, or `name`/`ref` over 128 chars |
| 404 | `intent_not_found` | Token doesn't exist, has expired (24h TTL), or was already consumed by a completed sign-up |
| 429 | `too_many_attempts` | More than 10 `/start` calls from the same IP within an hour — back off using the `Retry-After` header |

## What `ref` is (and isn't)

`ref` is a free-text label (max 128 chars) you can attach when starting the intent —
useful for the owner to know who referred this signup ("agent-42", a task ID, a
campaign name, whatever you choose). It's stored on the intent and, once the human's
account is first materialized, copied once into their `user_access.referredBy` column.

**It never grants access, never changes the account's status, and is never checked
against anything.** The allowlist decision (active vs. pending) is made purely by
email match — `ref` is metadata for a human reviewing the waitlist, nothing more.

## Not your job

- Minting/checking the intent is the whole extent of your responsibility. Don't try to
  call Better Auth endpoints directly, don't try to set a password on the human's
  behalf, and don't try to click the verification link for them — none of that is
  reachable or appropriate from an agent context.
- If the human already has an account, this flow isn't needed — point them at the
  normal sign-in page instead.
