import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { activityLog, files, shares } from "@defs";

import app from "../../src/index";
import { jsonHeaders, resetRuntime, runtime, seedDriveFile, seedFolder } from "./edge-runtime";

async function seedFolderShare(folderPath: string, id: string): Promise<{ shareId: string; accessToken: string }> {
  await seedFolder(folderPath);
  await runtime.db.insert(shares).values({
    id,
    fileId: null,
    folderPath,
    passwordHash: null,
    passwordVersion: 1,
    maxDownloads: null,
    downloadCount: 0,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  });
  runtime.secrets.set("AGENT_TOKEN", "integration-share-secret");

  const response = await app.request(`/api/public/s/${id}/access`, {
    method: "POST",
    headers: jsonHeaders(),
    body: "{}",
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { accessToken: string };
  return { shareId: id, accessToken: body.accessToken };
}

describe("public share performance limits", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("paginates public folder file listings with limit and offset", async () => {
    await seedDriveFile({ id: "page-a", path: "/shared/a.txt", body: "a" });
    await seedDriveFile({ id: "page-b", path: "/shared/b.txt", body: "b" });
    await seedDriveFile({ id: "page-c", path: "/shared/c.txt", body: "c" });
    const { shareId, accessToken } = await seedFolderShare("/shared", "share-page");

    const response = await app.request(`/api/public/s/${shareId}/files?limit=2&offset=1`, {
      headers: { "x-access-token": accessToken },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { files: Array<{ id: string; path: string }>; limit: number; offset: number };
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.files.map((file) => file.id)).toEqual(["page-b", "page-c"]);
    expect(body.files.map((file) => file.path)).toEqual(["b.txt", "c.txt"]);
  });

  it("keeps folder share info size and fileCount correct via aggregates", async () => {
    await seedDriveFile({ id: "summary-a", path: "/summary/a.txt", body: "aa" });
    await seedDriveFile({ id: "summary-b", path: "/summary/b.txt", body: "bbb" });
    await seedDriveFile({ id: "summary-c", path: "/summary/nested/c.txt", body: "cccc" });
    await seedDriveFile({ id: "summary-deleted", path: "/summary/deleted.txt", body: "ignored" });
    await runtime.db.update(files).set({ deletedAt: new Date().toISOString() }).where(eq(files.id, "summary-deleted"));
    const { shareId } = await seedFolderShare("/summary", "share-summary");

    const response = await app.request(`/api/public/s/${shareId}`);

    expect(response.status).toBe(200);
    const body = await response.json() as { type: string; name: string; size: number; fileCount: number };
    expect(body.type).toBe("folder");
    expect(body.name).toBe("summary");
    expect(body.size).toBe(9);
    expect(body.fileCount).toBe(3);
  });

  it("rejects folder ZIP downloads with more than 400 files", async () => {
    for (let index = 0; index < 401; index += 1) {
      const padded = String(index).padStart(3, "0");
      await seedDriveFile({ id: `bulk-${padded}`, path: `/bulk/file-${padded}.txt`, body: "x" });
    }
    const { shareId, accessToken } = await seedFolderShare("/bulk", "share-bulk");

    const response = await app.request(`/api/public/s/${shareId}/download-zip`, {
      headers: { "x-access-token": accessToken },
    });

    expect(response.status).toBe(413);
    const body = await response.json() as {
      error: { code: string; hint: string; filesEndpoint: string; fileCount: number; maxFileCount: number };
    };
    expect(body.error.code).toBe("zip_file_count_exceeded");
    expect(body.error.fileCount).toBe(401);
    expect(body.error.maxFileCount).toBe(400);
    expect(body.error.filesEndpoint).toBe(`/api/public/s/${shareId}/files?limit=500&offset=0`);
    expect(body.error.hint).toContain("/files?limit=500&offset=0");
    expect(body.error.hint).toContain("/download?fileId=<id>");
  });

  it("logs one bounded summary event for folder ZIP downloads", async () => {
    for (let index = 0; index < 55; index += 1) {
      const padded = String(index).padStart(3, "0");
      await seedDriveFile({ id: `zip-${padded}`, path: `/zip-small/file-${padded}.txt`, body: "x" });
    }
    const { shareId, accessToken } = await seedFolderShare("/zip-small", "share-zip-small");

    const response = await app.request(`/api/public/s/${shareId}/download-zip`, {
      headers: { "x-access-token": accessToken },
    });

    expect(response.status).toBe(200);
    const rows = await runtime.db
      .select()
      .from(activityLog)
      .where(eq(activityLog.eventType, "share.downloaded"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetId).toBe(shareId);
    expect(rows[0]?.targetPath).toBe("/zip-small");
    const metadata = JSON.parse(rows[0]?.metadata ?? "{}") as { mode?: string; count?: number; fileIds?: string[]; totalSize?: number };
    expect(metadata.mode).toBe("zip");
    expect(metadata.count).toBe(55);
    expect(metadata.totalSize).toBe(55);
    expect(metadata.fileIds).toHaveLength(50);
    expect(metadata.fileIds?.[0]).toBe("zip-000");
    expect(metadata.fileIds?.[49]).toBe("zip-049");
  });
});
