import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { files, memories } from "../../src/defs";
import { getMemory, listMemories, recallMemories } from "../../src/lib/memory";
import { resetRuntime, runtime, seedDriveFile, seedMemory, seedOwner } from "./edge-runtime";

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

  it("owner B cannot recall/list/get owner A's memory", async () => {
    seedOwner({ email: "a@x.test", id: "A" });
    await seedMemory({ id: "ma", key: "secret", content: "A's private note", ownerId: "A" });
    // list is owner-scoped:
    expect(await listMemories(runtime.db as never, 100, 0, "B")).toHaveLength(0);
    expect(await listMemories(runtime.db as never, 100, 0, "A")).toHaveLength(1);
    // recall is owner-scoped:
    expect(await recallMemories(runtime.db as never, "private", 10, "B")).toHaveLength(0);
    expect(await recallMemories(runtime.db as never, "private", 10, "A")).toHaveLength(1);
    // get by id/key is owner-scoped:
    expect(await getMemory(runtime.db as never, "ma", "B")).toBeNull();
    expect(await getMemory(runtime.db as never, "secret", "B")).toBeNull();
    expect(await getMemory(runtime.db as never, "ma", "A")).not.toBeNull();
  });
});
