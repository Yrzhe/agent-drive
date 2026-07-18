import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { files, memories, contacts } from "../../src/defs";
import { resetRuntime, runtime, seedDriveFile, seedMemory, seedContact } from "./edge-runtime";

describe("Part ①b — per-owner uniqueness (#30)", () => {
  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  it("two owners can each hold /report.txt", async () => {
    await seedDriveFile({ id: "fa", path: "/report.txt", body: "a", ownerId: "A" });
    await seedDriveFile({ id: "fb", path: "/report.txt", body: "b", ownerId: "B" }); // must NOT throw
    const rows = await runtime.db.select().from(files).where(eq(files.path, "/report.txt"));
    expect(rows.map((r) => r.ownerId).sort()).toEqual(["A", "B"]);
  });

  it("same owner cannot hold /report.txt twice", async () => {
    await seedDriveFile({ id: "f1", path: "/dup.txt", body: "a", ownerId: "A" });
    await expect(seedDriveFile({ id: "f2", path: "/dup.txt", body: "b", ownerId: "A" }))
      .rejects.toThrow(/unique/i);
  });

  it("two owners can each hold memory key 'profile' and contact name 'peer'", async () => {
    await seedMemory({ id: "m1", key: "profile", content: "a", ownerId: "A" });
    await seedMemory({ id: "m2", key: "profile", content: "b", ownerId: "B" }); // must NOT throw
    await seedContact({ id: "c1", name: "peer", url: "https://a.peer", publicKeyJwk: {}, ownerId: "A" });
    await seedContact({ id: "c2", name: "peer", url: "https://b.peer", publicKeyJwk: {}, ownerId: "B" }); // must NOT throw
    expect((await runtime.db.select().from(memories).where(eq(memories.key, "profile"))).length).toBe(2);
    expect((await runtime.db.select().from(contacts).where(eq(contacts.name, "peer"))).length).toBe(2);
  });
});
