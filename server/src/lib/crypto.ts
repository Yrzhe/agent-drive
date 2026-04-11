import { ACCESS_TOKEN_TTL_MS } from "../types";

export function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return null;
  return token.trim();
}

const PBKDF2_PREFIX = "pbkdf2";
const PBKDF2_HASH = "SHA-256";
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_DERIVED_BITS = 256;

function toBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  return input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function toHex(bytes: ArrayBuffer | ArrayBufferView): string {
  return Array.from(toBytes(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function manualTimingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  const subtle = crypto.subtle as {
    timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    try {
      return subtle.timingSafeEqual(left, right);
    } catch {
      // Fallback to manual implementation for environments that throw on length mismatch.
    }
  }
  return manualTimingSafeEqual(left, right);
}

export function timingSafeEqualStrings(left: string, right: string): boolean {
  return timingSafeEqualBytes(new TextEncoder().encode(left), new TextEncoder().encode(right));
}

async function legacySha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

async function derivePbkdf2Hex(value: string, salt: Uint8Array, iterations: number): Promise<string> {
  const password = new TextEncoder().encode(value);
  const key = await crypto.subtle.importKey("raw", password, { name: "PBKDF2" }, false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: PBKDF2_HASH, salt, iterations },
    key,
    PBKDF2_DERIVED_BITS
  );
  return toHex(derived);
}

export async function sha256Hex(value: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const derivedHex = await derivePbkdf2Hex(value, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${toHex(salt)}$${derivedHex}`;
}

export async function verifyPasswordHash(value: string, hash: string): Promise<boolean> {
  const parts = hash.split("$");
  if (parts.length === 4 && parts[0] === PBKDF2_PREFIX) {
    const iterations = Number.parseInt(parts[1] ?? "", 10);
    const salt = fromHex(parts[2] ?? "");
    const expected = fromHex(parts[3] ?? "");
    if (Number.isInteger(iterations) && iterations > 0 && salt && expected) {
      const derivedHex = await derivePbkdf2Hex(value, salt, iterations);
      const derived = fromHex(derivedHex);
      if (derived && timingSafeEqualBytes(derived, expected)) return true;
    }
  }

  const legacy = await legacySha256Hex(value);
  return timingSafeEqualStrings(legacy, hash);
}

export async function hmacSha256Hex(key: string, value: string): Promise<string> {
  const encodedKey = new TextEncoder().encode(key);
  const encodedValue = new TextEncoder().encode(value);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encodedKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encodedValue);
  return toHex(signature);
}

export async function createAccessToken(shareId: string, secret: string): Promise<{ token: string; expiresAt: string }> {
  const issuedAt = Date.now();
  const signature = await hmacSha256Hex(secret, `${shareId}:${issuedAt}`);
  return {
    token: `${issuedAt}.${signature}`,
    expiresAt: new Date(issuedAt + ACCESS_TOKEN_TTL_MS).toISOString(),
  };
}

export async function verifyAccessToken(token: string | undefined, shareId: string, secret: string): Promise<boolean> {
  if (!token) return false;
  const [timestampPart, signature] = token.split(".");
  if (!timestampPart || !signature) return false;

  const issuedAt = Number(timestampPart);
  if (!Number.isFinite(issuedAt)) return false;

  const now = Date.now();
  if (issuedAt > now + 60_000) return false;
  if (now - issuedAt > ACCESS_TOKEN_TTL_MS) return false;

  const expected = await hmacSha256Hex(secret, `${shareId}:${issuedAt}`);
  return timingSafeEqualStrings(expected, signature);
}
