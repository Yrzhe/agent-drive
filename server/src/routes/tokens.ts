import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";

import { oauthTokens } from "@defs";

import { getRequestActor, logEvent } from "../lib/activity";
import { hashPassword } from "../lib/crypto";
import { ApiError, withErrorHandling } from "../lib/errors";
import { nowIso } from "../lib/files";
import { MINTABLE_TOKEN_SCOPES, formatPathScope, isMcpScope, parsePathScope, serializeScopes, type McpScope } from "../lib/mcp-scopes";
import { requireSessionAuth } from "../lib/rest-scopes";

export const tokensRoutes = new Hono();

/** Synthetic clientId separating owner-minted drive tokens from OAuth tokens. */
export const DRIVE_TOKEN_CLIENT_ID = "drive_token";

const DEFAULT_EXPIRES_DAYS = 90;
const MAX_EXPIRES_DAYS = 365;
const MAX_LABEL_CHARS = 64;

export function validateMintScopes(input: unknown): McpScope[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ApiError(400, "validation_error", `scopes must be a non-empty array from: ${MINTABLE_TOKEN_SCOPES.join(", ")}`);
  }
  const scopes: McpScope[] = [];
  for (const value of input) {
    if (typeof value !== "string" || !isMcpScope(value) || !MINTABLE_TOKEN_SCOPES.includes(value)) {
      throw new ApiError(400, "validation_error", `Unknown or non-mintable scope: ${String(value)}. Mintable: ${MINTABLE_TOKEN_SCOPES.join(", ")}`);
    }
    if (!scopes.includes(value)) scopes.push(value);
  }
  return scopes;
}

export function validatePathPrefix(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string") throw new ApiError(400, "validation_error", "pathPrefix must be a string");
  const prefix = parsePathScope(input.startsWith("path:") ? input : `path:${input}`);
  if (prefix === null) {
    throw new ApiError(400, "validation_error", "pathPrefix must be an absolute path like /handoffs (no .., //, or glob)");
  }
  return prefix;
}

export function validateExpiresDays(input: unknown): number {
  if (input === undefined || input === null) return DEFAULT_EXPIRES_DAYS;
  const days = Number(input);
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_DAYS) {
    throw new ApiError(400, "validation_error", `expiresInDays must be an integer between 1 and ${MAX_EXPIRES_DAYS}`);
  }
  return days;
}

function toTokenObject(row: typeof oauthTokens.$inferSelect) {
  return {
    id: row.id,
    label: row.label,
    scopes: row.scope.split(/\s+/u).filter(Boolean),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    expired: Date.parse(row.expiresAt) <= Date.now(),
  };
}

tokensRoutes.post(
  "/",
  withErrorHandling(async (c) => {
    requireSessionAuth(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      label?: unknown;
      scopes?: unknown;
      pathPrefix?: unknown;
      expiresInDays?: unknown;
    };

    const scopes = validateMintScopes(body.scopes);
    const pathPrefix = validatePathPrefix(body.pathPrefix);
    const expiresInDays = validateExpiresDays(body.expiresInDays);
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, MAX_LABEL_CHARS) : null;

    const grantedScopes: string[] = [...scopes];
    if (pathPrefix) grantedScopes.push(formatPathScope(pathPrefix));

    const { auth } = await import("edgespark/http");
    if (!auth.isAuthenticated()) throw new ApiError(401, "unauthorized", "Authentication required");

    const id = `dtk_${nanoid(24)}`;
    const secret = nanoid(48);
    const { db } = await import("edgespark");
    const [created] = await db
      .insert(oauthTokens)
      .values({
        id,
        accessTokenHash: await hashPassword(secret),
        refreshTokenHash: null,
        clientId: DRIVE_TOKEN_CLIENT_ID,
        userId: auth.user.id,
        scope: serializeScopes(grantedScopes),
        expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
        refreshExpiresAt: null,
        createdAt: nowIso(),
        revokedAt: null,
        sourceCodeId: null,
        label,
      })
      .returning();

    await logEvent(db, {
      eventType: "token.minted",
      targetType: "token",
      targetId: created.id,
      actor: await getRequestActor(),
      metadata: { label, scopes: grantedScopes, expiresAt: created.expiresAt },
    });

    return c.json(
      {
        token: `${id}.${secret}`,
        hint: "This token is shown once. Save it now.",
        tokenInfo: toTokenObject(created),
      },
      201
    );
  })
);

tokensRoutes.get(
  "/",
  withErrorHandling(async (c) => {
    requireSessionAuth(c);
    const { db } = await import("edgespark");
    const rows = await db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.clientId, DRIVE_TOKEN_CLIENT_ID))
      .orderBy(desc(oauthTokens.createdAt));
    return c.json({ tokens: rows.map(toTokenObject) });
  })
);

tokensRoutes.delete(
  "/:id",
  withErrorHandling(async (c) => {
    requireSessionAuth(c);
    const id = c.req.param("id");
    if (!id) throw new ApiError(400, "validation_error", "Missing path param: id");

    const { db } = await import("edgespark");
    const revoked = await db
      .update(oauthTokens)
      .set({ revokedAt: nowIso() })
      .where(and(eq(oauthTokens.id, id), eq(oauthTokens.clientId, DRIVE_TOKEN_CLIENT_ID)))
      .returning();
    if (revoked.length === 0) throw new ApiError(404, "token_not_found", "Token not found");

    await logEvent(db, {
      eventType: "token.revoked",
      targetType: "token",
      targetId: id,
      actor: await getRequestActor(),
      metadata: { label: revoked[0].label },
    });
    return c.json({ revoked: toTokenObject(revoked[0]) });
  })
);
