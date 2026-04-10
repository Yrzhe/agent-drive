import { ACCESS_TOKEN_TTL_MS } from "../types";

export function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return null;
  return token.trim();
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
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
  return expected === signature;
}
