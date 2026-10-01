import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import type { AppDb } from "../../types";
import type { PlatformAuth, PlatformRuntime } from "../types";
import { drizzleSchema } from "./defs";
import { resolveSitesUser } from "./identity";
import { createSitesStorage } from "./storage";
import { cleanupExpiredUploads } from "./cleanup";
import type { SitesEnv, SitesExecutionContext } from "./types";

export async function createSitesRuntime(c: Context<SitesEnv>, execution: SitesExecutionContext): Promise<PlatformRuntime> {
  if (!c.env.DB || !c.env.BUCKET || !c.env.OWNER_EMAIL?.trim() || !c.env.AGENT_TOKEN) {
    throw new Error("Sites bindings, OWNER_EMAIL and AGENT_TOKEN must be configured");
  }
  const db = drizzle(c.env.DB as never, { schema: drizzleSchema }) as unknown as AppDb;
  const user = await resolveSitesUser(db, c.req.raw.headers);
  if (Math.random() < 0.02) execution.waitUntil(cleanupExpiredUploads(db, c.env.BUCKET).catch(() => {}));
  const auth: PlatformAuth = {
    user,
    isAuthenticated(): this is PlatformAuth & { readonly user: NonNullable<PlatformAuth["user"]> } { return this.user !== null; },
  };
  const origin = (c.env.ALLOWED_ORIGIN || new URL(c.req.url).origin).replace(/\/+$/u, "");
  return {
    kind: "sites", db, auth,
    storage: createSitesStorage(db, c.env.BUCKET, origin, c.env.AGENT_TOKEN, () => c.get("ownerId") ?? user?.id ?? null),
    vars: { get: (key) => c.env[key] ?? null },
    secret: { get: (key) => c.env[key] ?? null },
    ctx: { environment: "production", runInBackground: (promise) => execution.waitUntil(promise) },
  };
}
