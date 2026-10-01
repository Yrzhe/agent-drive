import { eq } from "drizzle-orm";
import type { AppDb } from "../../types";
import type { PlatformUser } from "../types";
import { driveUsers } from "./schema";

/** Called only by the Sites entrypoint behind its trusted dispatcher. */
export async function resolveSitesUser(db: AppDb, headers: Headers): Promise<PlatformUser | null> {
  const subject = headers.get("oai-authenticated-user-id");
  const email = headers.get("oai-authenticated-user-email")?.trim();
  if (!subject && !email) return null;
  if (!subject || subject.length > 512 || !email || email.length > 320 || !email.includes("@")) {
    throw new Error("Incomplete authenticated Sites identity");
  }
  let name = email;
  const encoded = headers.get("oai-authenticated-user-full-name");
  if (encoded && headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
    try { name = decodeURIComponent(encoded).slice(0, 256) || email; } catch { /* optional display name */ }
  }
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`siwc:${subject}`));
  const id = "siwc_" + Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
  const now = new Date();
  await db.insert(driveUsers).values({ id, subject, email, name, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: driveUsers.subject, set: { email, name, updatedAt: now } });
  const [row] = await db.select().from(driveUsers).where(eq(driveUsers.subject, subject)).limit(1);
  if (!row) throw new Error("Failed to materialize Sites identity");
  return { id: row.id, email: row.email, name: row.name, image: null, emailVerified: true, isAnonymous: false, createdAt: row.createdAt };
}
