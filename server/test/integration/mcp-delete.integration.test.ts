import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { files, shares } from "../../src/defs";
import { callMcpTool, listMcpTools } from "../../src/lib/mcp-tools";
import { createPendingUploadMarker } from "../../src/lib/pending-marker";
import { driveObjectKey } from "../../src/lib/object-keys";
import { resetRuntime, runtime, seedDriveFile, seedFolder } from "./edge-runtime";

const scopes = ["read:drive", "write:drive", "path:/"];
const remove = (id: string, owner: string | null = "A", granted = scopes) =>
  callMcpTool(runtime.db as never, "https://drive.test", granted, "delete_file", { file_id: id }, owner);

describe("MCP delete_file", () => {
  beforeEach(() => resetRuntime());
  afterAll(() => runtime.sqlite?.close());

  it("trashes a pending file, frees its path, revokes shares and leaves .keep alone", async () => {
    await seedDriveFile({ id: "pending", path: "/image/poster.png", body: "", ownerId: "A" });
    await seedDriveFile({ id: "keep", path: "/image/.keep", body: "", ownerId: "A" });
    await runtime.db.update(files).set({ s3Uri: createPendingUploadMarker(500, "pending/poster.png") }).where(eq(files.id, "pending"));
    await runtime.db.insert(shares).values({ id: "old-share", fileId: "pending", ownerId: "A" });
    expect(JSON.parse((await remove("pending")).content[0].text)).toMatchObject({ trashed: 1, targetId: "pending", path: "/image/poster.png" });
    const [old] = await runtime.db.select().from(files).where(eq(files.id, "pending"));
    expect(old.deletedAt).not.toBeNull();
    expect(old.path).toContain("~trash~pending");
    expect(await runtime.db.select().from(shares)).toHaveLength(0);
    const [keep] = await runtime.db.select().from(files).where(eq(files.id, "keep"));
    expect(keep.deletedAt).toBeNull();
    await seedDriveFile({ id: "replacement", path: "/image/poster.png", body: "new image", ownerId: "A" });
    expect(JSON.parse((await remove("pending")).content[0].text)).toMatchObject({ trashed: 0, alreadyTrashed: true });
    const [replacement] = await runtime.db.select().from(files).where(eq(files.id, "replacement"));
    expect(replacement.deletedAt).toBeNull();
  });

  it("keeps completed bytes recoverable in storage", async () => {
    await seedDriveFile({ id: "saved", path: "/saved.txt", body: "recover me", ownerId: "A" });
    await remove("saved");
    expect(await runtime.storage.from("drive").get(driveObjectKey("saved", "saved.txt"))).not.toBeNull();
  });

  it("enforces scope and identity and never takes another owner's same-path file", async () => {
    await seedDriveFile({ id: "private", path: "/outside/private.txt", body: "secret", ownerId: "B" });
    await seedDriveFile({ id: "mine", path: "/outside/private.txt", body: "mine", ownerId: "A" });
    await expect(remove("private")).rejects.toThrow("file_not_found");
    await expect(remove("mine", "A", ["read:drive", "path:/"])).rejects.toThrow("invalid_scope:write:drive");
    await expect(remove("mine", "A", ["write:drive", "path:/image/*"])).rejects.toThrow("invalid_scope:path:");
    await expect(remove("mine", null)).rejects.toThrow("identity_required");
    expect((await runtime.db.select().from(files)).every((file) => file.deletedAt === null)).toBe(true);
  });

  it("rejects folders and advertises a destructive, idempotent write action", async () => {
    await seedFolder("/image", "A");
    const [folder] = await runtime.db.select().from(files).where(eq(files.path, "/image"));
    await expect(remove(folder.id)).rejects.toThrow("only accepts files");
    expect(listMcpTools(scopes).find((tool) => tool.name === "delete_file")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(listMcpTools(["read:drive"]).some((tool) => tool.name === "delete_file")).toBe(false);
  });
});
