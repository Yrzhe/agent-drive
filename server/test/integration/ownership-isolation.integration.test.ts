import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { files, memories } from "../../src/defs";
import { resetRuntime, runtime, seedDriveFile, seedMemory } from "./edge-runtime";

describe("two-owner isolation harness (#30 Part ①a)", () => {
  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  it("seeds rows under a specific owner", async () => {
    await seedDriveFile({ id: "fa", path: "/a.txt", body: "a", ownerId: "A" });
    await seedMemory({ id: "ma", key: "ka", content: "ca", ownerId: "A" });
    const [f] = await runtime.db.select().from(files).where(eq(files.id, "fa")).limit(1);
    const [m] = await runtime.db.select().from(memories).where(eq(memories.id, "ma")).limit(1);
    expect(f?.ownerId).toBe("A");
    expect(m?.ownerId).toBe("A");
  });
});
