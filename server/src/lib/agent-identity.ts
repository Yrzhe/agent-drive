import { eq } from "drizzle-orm";

import { agentIdentity } from "@defs";

import { nowIso } from "./files";
import type { AppDb } from "../types";

export type AgentIdentityRow = typeof agentIdentity.$inferSelect;

const IDENTITY_ROW_ID = "self";
const SIGNING_ALGORITHM = "Ed25519";

/** Structural JWK type — the server tsconfig has no DOM lib. */
export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  d?: string;
  [key: string]: unknown;
}

export interface AgentIdentity {
  publicKeyJwk: Jwk;
  algorithm: string;
  createdAt: string;
}

interface GeneratedKeyPair {
  publicKeyJwk: Jwk;
  privateKeyJwk: Jwk;
}

// Repo convention: cast crypto.subtle structurally (see crypto.ts) — the
// ESNext-only lib has no WebCrypto types, and Ed25519 lags in DOM types too.
interface SubtleLike {
  generateKey(algorithm: { name: string }, extractable: boolean, usages: string[]): Promise<{ publicKey: unknown; privateKey: unknown }>;
  exportKey(format: "jwk", key: unknown): Promise<Jwk>;
}

async function generateSigningKeyPair(): Promise<GeneratedKeyPair> {
  const subtle = crypto.subtle as unknown as SubtleLike;
  const keyPair = await subtle.generateKey({ name: SIGNING_ALGORITHM }, true, ["sign", "verify"]);
  const [publicKeyJwk, privateKeyJwk] = await Promise.all([
    subtle.exportKey("jwk", keyPair.publicKey),
    subtle.exportKey("jwk", keyPair.privateKey),
  ]);
  return { publicKeyJwk, privateKeyJwk };
}

/**
 * Load this deployment's signing identity, generating and persisting an
 * Ed25519 keypair on first use. The private key never leaves the database /
 * server trust domain; only the public JWK is ever serialized into responses.
 */
export async function getOrCreateAgentIdentity(db: AppDb): Promise<AgentIdentity> {
  const [existing] = await db.select().from(agentIdentity).where(eq(agentIdentity.id, IDENTITY_ROW_ID)).limit(1);
  if (existing) return toPublicIdentity(existing);

  const generated = await generateSigningKeyPair();
  try {
    const [created] = await db
      .insert(agentIdentity)
      .values({
        id: IDENTITY_ROW_ID,
        publicKeyJwk: JSON.stringify(generated.publicKeyJwk),
        privateKeyJwk: JSON.stringify(generated.privateKeyJwk),
        algorithm: SIGNING_ALGORITHM,
        createdAt: nowIso(),
      })
      .returning();
    return toPublicIdentity(created);
  } catch (error) {
    // Two concurrent first requests: the loser of the primary-key race must
    // serve the winner's key, never a second identity.
    const [row] = await db.select().from(agentIdentity).where(eq(agentIdentity.id, IDENTITY_ROW_ID)).limit(1);
    if (row) return toPublicIdentity(row);
    throw error;
  }
}

function toPublicIdentity(row: AgentIdentityRow): AgentIdentity {
  return {
    publicKeyJwk: JSON.parse(row.publicKeyJwk) as Jwk,
    algorithm: row.algorithm,
    createdAt: row.createdAt,
  };
}

/**
 * A2A-compatible Agent Card. Format follows the A2A AgentCard shape (name /
 * description / url / version / capabilities / skills / securitySchemes);
 * Drive-specific surfaces live under the `x-agent-drive` extension so A2A
 * clients can ignore them safely.
 */
export function buildAgentCard(identity: AgentIdentity, origin: string, appVersion: string) {
  const host = new URL(origin).host;
  return {
    protocolVersion: "1.0",
    name: `Agent Drive @ ${host}`,
    description:
      "Self-hosted agent-native drive: persistent file exchange, share links, versioned bundles, and cross-session memory, operated via MCP and REST.",
    url: origin,
    version: appVersion,
    provider: { organization: "self-hosted", url: origin },
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "file-exchange",
        name: "File exchange",
        description: "Upload, organize, and share files; other agents download via share links without an account.",
      },
      {
        id: "memory",
        name: "Persistent memory",
        description: "remember/recall MCP tools with full-text search for cross-session agent context.",
      },
      {
        id: "bundles",
        name: "Versioned bundles",
        description: "Push/pull versioned directory bundles with history and rollback (adrive sync).",
      },
    ],
    securitySchemes: {
      oauth2: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: `${origin}/api/public/oauth/authorize`,
            tokenUrl: `${origin}/api/public/oauth/token`,
            scopes: {
              "read:drive": "Read files and folders",
              "write:drive": "Create and update files and folders",
              "share:create": "Create share links",
              "read:memory": "Read agent memories",
              "write:memory": "Create and update agent memories",
            },
          },
        },
        description: `OAuth 2.1 with dynamic client registration and PKCE. AS metadata: ${origin}/api/public/.well-known/oauth-authorization-server`,
      },
      bearer: {
        type: "http",
        scheme: "bearer",
        description: "Owner bearer token (AGENT_TOKEN) for self-hosted single-user mode.",
      },
    },
    signing: {
      algorithm: identity.algorithm,
      publicKeyJwk: identity.publicKeyJwk,
      createdAt: identity.createdAt,
      purpose: "Future peer handshakes and bundle signatures verify against this key.",
    },
    "x-agent-drive": {
      // A2A specifies root /.well-known/agent.json, but this platform only
      // routes /api/* through the server — the canonical card URL below is a
      // documented deviation.
      cardUrl: `${origin}/api/public/.well-known/agent.json`,
      mcp: `${origin}/api/public/mcp`,
      rest: `${origin}/api/public/v1`,
      guide: `${origin}/api/public/guide`,
      llmsTxt: `${origin}/llms.txt`,
      inbox: null,
      inboxStatus: "planned — direct Drive-to-Drive delivery is not implemented yet; use share links for handoff.",
    },
  };
}
