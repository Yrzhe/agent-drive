import { isNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { activityLog, contacts, files, memories } from "../../src/defs";
import { backfillOwnerId } from "../../src/lib/owner-backfill";
import { jsonHeaders, resetRuntime, runtime, seedDriveFile, seedOwner, useBearer, useSession } from "./edge-runtime";

const SCOPES = ["read:drive", "write:drive", "share:create", "path:/"];
const OWNER_ID = "owner-123";

async function nullOwnerCount(table: typeof files | typeof activityLog): Promise<number> {
  const [{ n }] = await runtime.db.select({ n: sql<number>`count(*)` }).from(table).where(isNull(sql`owner_id`));
  return Number(n);
}

async function seedSomeRows(): Promise<void> {
  await seedDriveFile({ id: "f1", path: "/a.txt", body: "a" });
  await seedDriveFile({ id: "f2", path: "/b.txt", body: "b" });
  await runtime.db.insert(activityLog).values({
    id: "act1", eventType: "file.uploaded", actor: "owner", createdAt: new Date().toISOString(),
  } as never);
  await runtime.db.insert(memories).values({
    id: "m1", key: "k", content: "c", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never);
  await runtime.db.insert(contacts).values({
    id: "c1", name: "peer", url: "https://peer.test", publicKeyJwk: "{}",
  } as never);
}

describe("multi-tenancy Phase 1a — owner_id column + backfill (#30)", () => {
  beforeEach(() => {
    resetRuntime();
    seedOwner({ email: "owner@example.test", id: OWNER_ID });
    runtime.vars.set("OWNER_EMAIL", "owner@example.test");
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("the migration added owner_id (a fresh row starts NULL)", async () => {
    await seedDriveFile({ id: "f1", path: "/a.txt", body: "a" });
    expect(await nullOwnerCount(files)).toBe(1); // column exists, unset on insert
  });

  it("backfill assigns owner_id on every content table", async () => {
    await seedSomeRows();
    const result = await backfillOwnerId(runtime.db as never, OWNER_ID);

    expect(result.ownerId).toBe(OWNER_ID);
    expect(result.complete).toBe(true);
    expect(result.tables.files.updated).toBe(2);
    expect(result.tables.activity_log.updated).toBe(1);
    expect(result.tables.memories.updated).toBe(1);
    expect(result.tables.contacts.updated).toBe(1);
    for (const t of Object.values(result.tables)) expect(t.remainingNull).toBe(0);

    expect(await nullOwnerCount(files)).toBe(0);
    expect(await nullOwnerCount(activityLog)).toBe(0);
  });

  it("is idempotent — a second run updates nothing", async () => {
    await seedSomeRows();
    await backfillOwnerId(runtime.db as never, OWNER_ID);
    const second = await backfillOwnerId(runtime.db as never, OWNER_ID);

    for (const t of Object.values(second.tables)) {
      expect(t.updated).toBe(0);
      expect(t.remainingNull).toBe(0);
    }
    expect(second.complete).toBe(true);
  });

  it("POST /admin/backfill-owner backfills as the owner (browser session)", async () => {
    await seedSomeRows();
    useSession({ email: "owner@example.test", id: OWNER_ID });
    const { default: app } = await import("../../src/index");

    const res = await app.request("/api/public/v1/admin/backfill-owner", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ownerId: string; complete: boolean };
    expect(body.ownerId).toBe(OWNER_ID);
    expect(body.complete).toBe(true);
    expect(await nullOwnerCount(files)).toBe(0);
  });

  it("rejects a bearer token — owner migration tooling is session-only (403)", async () => {
    await seedSomeRows();
    const { default: app } = await import("../../src/index");

    const res = await app.request("/api/public/v1/admin/backfill-owner", {
      method: "POST", headers: jsonHeaders(useBearer(SCOPES)),
    });
    expect(res.status).toBe(403);
    expect(await nullOwnerCount(files)).toBeGreaterThan(0); // nothing backfilled
  });

  it("fails closed (409) when the owner cannot be resolved", async () => {
    runtime.vars.delete("OWNER_EMAIL"); // unresolvable
    await seedSomeRows();
    const before = await nullOwnerCount(files);
    useSession({ email: "owner@example.test", id: OWNER_ID });
    const { default: app } = await import("../../src/index");

    const res = await app.request("/api/public/v1/admin/backfill-owner", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await nullOwnerCount(files)).toBe(before); // nothing backfilled
  });

  it("only backfills NULLs — never reassigns an already-owned row", async () => {
    await seedSomeRows();
    await runtime.db.update(files).set({ ownerId: "someone-else" } as never).where(sql`id = 'f1'`);

    await backfillOwnerId(runtime.db as never, OWNER_ID);

    const [row] = await runtime.db.select({ o: sql<string>`owner_id` }).from(files).where(sql`id = 'f1'`);
    expect(row.o).toBe("someone-else"); // untouched — backfill is NULL-only
  });
});
