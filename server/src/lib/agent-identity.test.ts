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
    expect(card.skills.map((s) => s.id)).toEqual(["file-exchange", "memory", "bundles"]);
    expect(card.securitySchemes.oauth2.type).toBe("oauth2");
    expect(card.securitySchemes.oauth2.flows.authorizationCode.tokenUrl).toBe("https://drive.example.com/api/public/oauth/token");
    expect(card.securitySchemes.oauth2.description).toContain("/.well-known/oauth-authorization-server");
  });

  it("publishes only the public key", () => {
    expect(card.signing.publicKeyJwk).toEqual(identity.publicKeyJwk);
    expect(JSON.stringify(card)).not.toContain('"d"');
  });

  it("marks the inbox as not yet available", () => {
    expect(card["x-agent-drive"].inbox).toBeNull();
    expect(card["x-agent-drive"].mcp).toBe("https://drive.example.com/api/public/mcp");
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
