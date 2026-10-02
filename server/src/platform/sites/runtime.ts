import { drizzle } from "drizzle-orm/d1";
import { and, eq, gt, notInArray } from "drizzle-orm";
import type { Context } from "hono";
import type { AppDb } from "../../types";
import type { PlatformAuth, PlatformRuntime } from "../types";
import { drizzleSchema } from "./defs";
import { resolveSitesUser } from "./identity";
import { createSitesStorage, SITES_MAX_FILE_BYTES } from "./storage";
import { cleanupExpiredUploads } from "./cleanup";
import { createVersions } from "./versions";
import { storeFileStream } from "./file-stream";
import { uploadSessions } from "./schema";
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
  // Transfers stay on the dispatcher-validated request origin. A configured
  // browser allowlist must not keep tickets pointing at an old Site hostname.
  const origin = new URL(c.req.url).origin;
  return {
    kind: "sites", db, auth,
    maxUploadBytes: SITES_MAX_FILE_BYTES,
    storeFileStream: (key, body, contentType, expectedSize, validateSize) => storeFileStream(c.env.BUCKET, key, body, contentType, expectedSize, validateSize),
    hasLiveUpload: async (fileId) => {
      const [active] = await db.select({ id: uploadSessions.id }).from(uploadSessions).where(and(eq(uploadSessions.fileId, fileId), gt(uploadSessions.expiresAt, Date.now()), notInArray(uploadSessions.state, ["aborted", "committed"]))).limit(1);
      return Boolean(active);
    },
    versioning: createVersions(db, c.env.DB, c.env.BUCKET),
    storage: createSitesStorage(db, c.env.BUCKET, origin, c.env.AGENT_TOKEN, () => c.get("ownerId") ?? user?.id ?? null),
    vars: { get: (key) => c.env[key] ?? (key === "MAX_FILE_BYTES" ? "671088640000" : key === "MAX_TOTAL_BYTES" ? "1099511627776" : null) },
    secret: { get: (key) => c.env[key] ?? null },
    ctx: { environment: "production", runInBackground: (promise) => execution.waitUntil(promise) },
  };
}
