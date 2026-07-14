import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { oauthTokens } from "@defs";

import app from "../../src/index";
import { jsonHeaders, resetRuntime, runtime, useSession } from "./edge-runtime";

const REDIRECT_URI = "https://client.example/cb";
const ORIGIN = "http://localhost";

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = `verifier-${"abcdefghij".repeat(5)}`; // >43 chars, URL-safe
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(digest) };
}

async function registerClient(): Promise<string> {
  const response = await app.request("/api/public/oauth/register", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: "reuse-test",
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as { client_id: string }).client_id;
}

async function mintCode(clientId: string, challenge: string): Promise<string> {
  const response = await app.request("/api/public/oauth/authorize/consent", {
    method: "POST",
    headers: jsonHeaders({ origin: ORIGIN }),
    body: JSON.stringify({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      approved: "true",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "read:drive",
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as { code: string }).code;
}

async function redeem(clientId: string, code: string, verifier: string): Promise<Response> {
  return app.request("/api/public/oauth/token", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: clientId,
    }),
  });
}

describe("OAuth authorization-code redemption", () => {
  beforeEach(() => {
    resetRuntime();
    useSession(); // OWNER_EMAIL unset → owner; consent requires an owner session
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("issues a token once and rejects a replay of the same code", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = await pkcePair();
    const code = await mintCode(clientId, challenge);

    const first = await redeem(clientId, code, verifier);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { access_token: string };
    expect(firstBody.access_token).toBeTruthy();

    const replay = await redeem(clientId, code, verifier);
    expect(replay.status).toBe(400);
    expect((await replay.json() as { error?: { code?: string } }).error?.code).toBe("invalid_grant");
  });

  it("revokes the token issued from a code when that code is replayed (RFC 6749 §10.5)", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = await pkcePair();
    const code = await mintCode(clientId, challenge);

    const first = await redeem(clientId, code, verifier);
    const issuedTokenId = ((await first.json() as { access_token: string }).access_token).split(".")[0];

    const [beforeReplay] = await runtime.db.select().from(oauthTokens).where(eq(oauthTokens.id, issuedTokenId));
    expect(beforeReplay?.revokedAt).toBeNull();

    await redeem(clientId, code, verifier); // replay

    const [afterReplay] = await runtime.db.select().from(oauthTokens).where(eq(oauthTokens.id, issuedTokenId));
    expect(afterReplay?.revokedAt).not.toBeNull();
  });
});
