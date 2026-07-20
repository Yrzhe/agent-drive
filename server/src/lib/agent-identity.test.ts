import { describe, expect, it } from "vitest";

import { buildAgentCard, type AgentIdentity } from "./agent-identity";

const identity: AgentIdentity = {
  publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc123" },
  algorithm: "Ed25519",
  createdAt: "2026-07-05T00:00:00.000Z",
};

describe("buildAgentCard", () => {
  const card = buildAgentCard(identity, "https://drive.example.com", "1.2");

  it("produces an A2A-compatible shape", () => {
    expect(card.protocolVersion).toBe("1.0");
    expect(card.name).toBe("Agent Drive @ drive.example.com");
    expect(card.url).toBe("https://drive.example.com");
    expect(card.skills.map((s) => s.id)).toEqual(["file-exchange", "memory", "bundles", "spaces"]);
    expect(card.securitySchemes.oauth2.type).toBe("oauth2");
    expect(card.securitySchemes.oauth2.flows.authorizationCode.tokenUrl).toBe("https://drive.example.com/api/public/oauth/token");
    expect(card.securitySchemes.oauth2.description).toContain("/.well-known/oauth-authorization-server");
  });

  it("publishes only the public key", () => {
    expect(card.signing.publicKeyJwk).toEqual(identity.publicKeyJwk);
    expect(JSON.stringify(card)).not.toContain('"d"');
  });

  it("advertises the live inbox endpoint", () => {
    expect(card["x-agent-drive"].inbox).toBe("https://drive.example.com/api/public/inbox");
    expect(card["x-agent-drive"].mcp).toBe("https://drive.example.com/api/public/mcp");
  });
});

describe("verifyWithJwk hardening", () => {
  const subtle = crypto.subtle as unknown as {
    generateKey(a: { name: string }, e: boolean, u: string[]): Promise<{ publicKey: unknown; privateKey: unknown }>;
    exportKey(f: "jwk", k: unknown): Promise<Record<string, unknown>>;
    sign(a: { name: string }, k: unknown, d: Uint8Array): Promise<ArrayBuffer>;
  };

  it("verifies a genuine Ed25519 signature and rejects a wrong key", async () => {
    const { verifyWithJwk, base64UrlEncode } = await import("./agent-identity");
    const pairA = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pairB = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const data = new TextEncoder().encode('{"from":"https://peer.example.com"}');
    const signature = base64UrlEncode(new Uint8Array(await subtle.sign({ name: "Ed25519" }, pairA.privateKey, data)));
    const publicA = (await subtle.exportKey("jwk", pairA.publicKey)) as import("./agent-identity").Jwk;
    const publicB = (await subtle.exportKey("jwk", pairB.publicKey)) as import("./agent-identity").Jwk;
    expect(await verifyWithJwk(publicA, data, signature)).toBe(true);
    expect(await verifyWithJwk(publicB, data, signature)).toBe(false);
    expect(await verifyWithJwk(publicA, new TextEncoder().encode("tampered"), signature)).toBe(false);
  });

  it("rejects non-Ed25519 keys outright (algorithm confusion guard)", async () => {
    const { verifyWithJwk } = await import("./agent-identity");
    const data = new TextEncoder().encode("payload");
    expect(await verifyWithJwk({ kty: "oct", k: "c2VjcmV0" }, data, "AAAA")).toBe(false);
    expect(await verifyWithJwk({ kty: "OKP", crv: "X25519", x: "abc" }, data, "AAAA")).toBe(false);
    expect(await verifyWithJwk({ kty: "OKP", crv: "Ed25519", x: "abc", d: "leaked-private" }, data, "AAAA")).toBe(false);
  });
});

describe("Ed25519 keygen (WebCrypto)", () => {
  it("generates an exportable OKP keypair whose public JWK has no private component", async () => {
    const subtle = crypto.subtle as unknown as {
      generateKey(a: { name: string }, e: boolean, u: string[]): Promise<{ publicKey: unknown; privateKey: unknown }>;
      exportKey(f: "jwk", k: unknown): Promise<Record<string, unknown>>;
    };
    const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicJwk = await subtle.exportKey("jwk", pair.publicKey);
    const privateJwk = await subtle.exportKey("jwk", pair.privateKey);
    expect(publicJwk.kty).toBe("OKP");
    expect(publicJwk.crv).toBe("Ed25519");
    expect(publicJwk.x).toBeTruthy();
    expect(publicJwk.d).toBeUndefined();
    expect(privateJwk.d).toBeTruthy();
  });
});
