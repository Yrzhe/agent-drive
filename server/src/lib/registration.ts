import { and, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { nanoid } from "nanoid";

import { registrationIntents } from "@defs";

import type { AppDb } from "../types";
import { ApiError } from "./errors";
import { nowIso } from "./files";

// Part ③ agent-native registration: a recipient's agent mints a short-lived intent on
// the human's behalf and hands back a pre-filled `/signup` link. The intent NEVER carries
// a password, session, or verification state — those still flow through the normal
// signup + email-verification path. This module only creates/reads/consumes the intent
// row; Task 2 wires `consumeRegistrationIntent` into the signup-completion endpoint and
// donates a consumed intent's `ref` into `user_access.referredBy` via `consumeIntentForEmail`.

const TOKEN_LENGTH = 32; // nanoid() takes a character count, not a byte count.
const INTENT_TTL_MS = 24 * 60 * 60 * 1000;

// Sampled opportunistic reaping of dead rows (expired or already-consumed), mirroring
// `rate-limit.ts`'s `CLEANUP_SAMPLE_RATE` pattern — best-effort, never blocks the caller
// on failure, never runs on every request.
const INTENT_CLEANUP_SAMPLE_RATE = 0.01;

// RFC 5321 max total email length — mirrors routes/admin.ts's requireValidEmail.
const MAX_EMAIL_CHARS = 254;
const MAX_NAME_CHARS = 128;
const MAX_REF_CHARS = 128;

export interface RegistrationIntentInput {
  email: string;
  name: string | null;
  ref: string | null;
}

export interface RegistrationIntentSummary {
  email: string;
  name: string | null;
  ref: string | null;
}

/**
 * Minimal email shape + length check — not full RFC 5322 validation, just enough to
 * reject obvious garbage. Mirrors `routes/admin.ts`'s `requireValidEmail` discipline so
 * the two public-facing email entry points agree on what "valid" means.
 */
function requireValidEmail(input: string): string {
  if (input.length === 0) throw new ApiError(400, "validation_error", "email is required");
  if (input.length > MAX_EMAIL_CHARS) {
    throw new ApiError(400, "validation_error", `email must be at most ${MAX_EMAIL_CHARS} characters`);
  }
  const at = input.indexOf("@");
  if (at <= 0 || at !== input.lastIndexOf("@") || at === input.length - 1) {
    throw new ApiError(400, "validation_error", "email must contain exactly one '@' with a non-empty local and domain part");
  }
  return input;
}

function parseOptionalField(input: unknown, maxChars: number, field: string): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") throw new ApiError(400, "validation_error", `${field} must be a string`);
  if (input.length > maxChars) {
    throw new ApiError(400, "validation_error", `${field} must be at most ${maxChars} characters`);
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate + normalize a `POST /start` body. Email is lowercased before storage so the
 * Task-2 consume-by-email lookup is case-insensitive without needing a `lower()` query.
 */
export function parseRegistrationStartBody(body: unknown): RegistrationIntentInput {
  const input = (body ?? {}) as { email?: unknown; name?: unknown; ref?: unknown };
  if (typeof input.email !== "string" || input.email.trim().length === 0) {
    throw new ApiError(400, "validation_error", "email is required");
  }
  const email = requireValidEmail(input.email.trim().toLowerCase());
  const name = parseOptionalField(input.name, MAX_NAME_CHARS, "name");
  const ref = parseOptionalField(input.ref, MAX_REF_CHARS, "ref");
  return { email, name, ref };
}

/**
 * Best-effort sampled cleanup of dead rows — expired (regardless of consumed state) or
 * already-consumed. Errors are swallowed: reaping is opportunistic housekeeping, never a
 * correctness dependency, so a failure here must never block intent creation.
 */
async function maybeReapExpiredIntents(db: AppDb): Promise<void> {
  if (Math.random() >= INTENT_CLEANUP_SAMPLE_RATE) return;
  try {
    const now = nowIso();
    await db
      .delete(registrationIntents)
      .where(or(lt(registrationIntents.expiresAt, now), isNotNull(registrationIntents.consumedAt)));
  } catch {
    // Best-effort — swallow and move on.
  }
}

/** Create a 24h registration intent. Never accepts or stores a password. */
export async function createRegistrationIntent(
  db: AppDb,
  input: RegistrationIntentInput
): Promise<{ token: string; expiresAt: string }> {
  await maybeReapExpiredIntents(db);
  const token = nanoid(TOKEN_LENGTH);
  const expiresAt = new Date(Date.now() + INTENT_TTL_MS).toISOString();
  await db.insert(registrationIntents).values({
    token,
    email: input.email,
    name: input.name,
    ref: input.ref,
    createdAt: nowIso(),
    expiresAt,
    consumedAt: null,
  } as never);
  return { token, expiresAt };
}

/** Read-only lookup for the `/signup` page prefill. Never consumes the intent. */
export async function getActiveRegistrationIntent(
  db: AppDb,
  token: string
): Promise<RegistrationIntentSummary | null> {
  const [row] = await db
    .select()
    .from(registrationIntents)
    .where(and(eq(registrationIntents.token, token), isNull(registrationIntents.consumedAt)))
    .limit(1);
  if (!row || Date.parse(row.expiresAt) <= Date.now()) return null;
  return { email: row.email, name: row.name, ref: row.ref };
}

/**
 * Atomically mark an intent consumed and return its data, or `null` if the token is
 * unknown, already consumed, or expired. The `consumedAt IS NULL` + `expiresAt > now`
 * conditions live in the same conditional UPDATE (mirrors
 * `public-shares.ts`'s `incrementDownloadCountOrThrow`) so two racing callers can never
 * both "win" the same intent. Not wired to a route yet — Task 2 calls this from the
 * signup-completion endpoint.
 */
export async function consumeRegistrationIntent(
  db: AppDb,
  token: string
): Promise<RegistrationIntentSummary | null> {
  const consumedAt = nowIso();
  const rows = await db
    .update(registrationIntents)
    .set({ consumedAt })
    .where(and(
      eq(registrationIntents.token, token),
      isNull(registrationIntents.consumedAt),
      gt(registrationIntents.expiresAt, consumedAt)
    ))
    .returning();
  const [row] = rows;
  if (!row) return null;
  return { email: row.email, name: row.name, ref: row.ref };
}

/**
 * Consume-by-email: donates a registration intent's `ref` into `user_access.referredBy`
 * when a user's access row is FIRST materialized (`resolveAccessStatus` in `access.ts`).
 * Referral only annotates the waitlist for the admin — it never grants access.
 *
 * Finds the newest unexpired, unconsumed intent for `email` (lowercased — intents are
 * always stored lowercased by `parseRegistrationStartBody`, so callers must pass an
 * already-lowercased/trimmed email for the match to hit) and atomically stamps
 * `consumedAt`, mirroring `consumeRegistrationIntent`'s race-safe conditional UPDATE:
 * the `consumedAt IS NULL` + `expiresAt > now` guard is re-checked in the UPDATE itself,
 * so a racing caller that already consumed this exact token loses cleanly (0 rows
 * affected) instead of double-donating the same intent.
 *
 * Returns `null` when no matching intent exists (or the caller lost the update race) —
 * callers must treat `null` the same as "no referral", never as an error.
 */
export async function consumeIntentForEmail(db: AppDb, email: string): Promise<{ ref: string | null } | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const now = nowIso();

  const [candidate] = await db
    .select({ token: registrationIntents.token })
    .from(registrationIntents)
    .where(and(
      eq(registrationIntents.email, normalizedEmail),
      isNull(registrationIntents.consumedAt),
      gt(registrationIntents.expiresAt, now)
    ))
    .orderBy(desc(registrationIntents.createdAt))
    .limit(1);
  if (!candidate) return null;

  const consumedAt = nowIso();
  const rows = await db
    .update(registrationIntents)
    .set({ consumedAt })
    .where(and(
      eq(registrationIntents.token, candidate.token),
      isNull(registrationIntents.consumedAt),
      gt(registrationIntents.expiresAt, consumedAt)
    ))
    .returning();
  const [row] = rows;
  if (!row) return null;
  return { ref: row.ref };
}
