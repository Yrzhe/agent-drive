import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { activityLog, buckets, files, shares } from "@defs";

import app from "../../src/index";
import { createAccessToken, hashPassword } from "../../src/lib/crypto";
import { PREVIEW_URL_TTL_SECS, SHARE_DOWNLOAD_URL_TTL_SECS } from "../../src/types";
import { jsonHeaders, resetRuntime, runtime, seedDriveFile, seedFolder } from "./edge-runtime";

const SHARE_SECRET = "integration-share-secret";

async function seedPasswordFileShare(): Promise<{ shareId: string; fileId: string }> {
  const fileId = await seedDriveFile({ id: "secret-file", path: "/private/Q3-layoffs.xlsx", body: "sensitive" });
  const shareId = "share-locked";
  runtime.secrets.set("AGENT_TOKEN", SHARE_SECRET);
  await runtime.db.insert(shares).values({
    id: shareId,
    fileId,
    folderPath: null,
    passwordHash: await hashPassword("hunter2"),
    passwordVersion: 1,
    maxDownloads: null,
    downloadCount: 0,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  });
  return { shareId, fileId };
}

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

async function seedFileShare(id: string, fileId: string): Promise<string> {
  runtime.secrets.set("AGENT_TOKEN", SHARE_SECRET);
  await runtime.db.insert(shares).values({
    id,
    fileId,
    folderPath: null,
    passwordHash: null,
    passwordVersion: 1,
    maxDownloads: null,
    downloadCount: 0,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  });
  const response = await app.request(`/api/public/s/${id}/access`, {
    method: "POST",
    headers: jsonHeaders(),
    body: "{}",
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { accessToken: string };
  return body.accessToken;
}

describe("share download URL lifetime", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("reports the download URL lifetime in-band, matching the TTL it was signed with", async () => {
    const fileId = await seedDriveFile({ id: "ttl-file", path: "/reports/q3.pdf", body: "payload" });
    const accessToken = await seedFileShare("share-ttl", fileId);

    const issuedAt = Date.now();
    const response = await app.request("/api/public/s/share-ttl/download", {
      headers: { "x-access-token": accessToken },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { expiresInSecs: number; expiresAt: string };

    // The wire contract: agents get a lifetime they can act on without racing prose in the guide.
    expect(body.expiresInSecs).toBe(SHARE_DOWNLOAD_URL_TTL_SECS);
    expect(SHARE_DOWNLOAD_URL_TTL_SECS).toBe(300);

    // expiresAt must derive from the SAME ttl handed to createPresignedGetUrl — otherwise the
    // reported lifetime and the signature's real lifetime can drift apart silently. The clock
    // is read after `issuedAt`, so the measured span sits just above the TTL, never below it.
    const signedTtlSecs = (Date.parse(body.expiresAt) - issuedAt) / 1000;
    expect(signedTtlSecs).toBeGreaterThanOrEqual(SHARE_DOWNLOAD_URL_TTL_SECS);
    expect(signedTtlSecs).toBeLessThan(SHARE_DOWNLOAD_URL_TTL_SECS + 5);
  });

  it("reports the owner preview lifetime consistently with the TTL it was signed with", async () => {
    const fileId = await seedDriveFile({ id: "preview-file", path: "/reports/q4.pdf", body: "payload" });
    runtime.secrets.set("AGENT_TOKEN", SHARE_SECRET);

    const issuedAt = Date.now();
    const response = await app.request(`/api/public/v1/files/${fileId}/preview`, {
      headers: { authorization: `Bearer ${SHARE_SECRET}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { expiresInSecs: number };
    expect(body.expiresInSecs).toBe(PREVIEW_URL_TTL_SECS);
    expect(Date.now() - issuedAt).toBeLessThan(PREVIEW_URL_TTL_SECS * 1000);
  });
});

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

  it("withholds filename and size for a password share until the access token is presented", async () => {
    const { shareId } = await seedPasswordFileShare();

    const locked = await app.request(`/api/public/s/${shareId}`);
    expect(locked.status).toBe(200);
    const lockedBody = await locked.json() as Record<string, unknown>;
    expect(lockedBody.hasPassword).toBe(true);
    expect(lockedBody.type).toBe("file");
    expect(lockedBody).not.toHaveProperty("name");
    expect(lockedBody).not.toHaveProperty("size");
    expect(lockedBody).not.toHaveProperty("fileCount");

    const { token } = await createAccessToken(shareId, SHARE_SECRET, 1);
    const unlocked = await app.request(`/api/public/s/${shareId}`, {
      headers: { "x-access-token": token },
    });
    expect(unlocked.status).toBe(200);
    const unlockedBody = await unlocked.json() as { name?: string; size?: number };
    expect(unlockedBody.name).toBe("Q3-layoffs.xlsx");
    expect(unlockedBody.size).toBe("sensitive".length);
  });

  it("marks a folder ZIP incomplete (X-Skipped-Count + _SKIPPED.txt) when a file's object is missing", async () => {
    await seedDriveFile({ id: "present", path: "/mix/ok.txt", body: "ok" });
    await seedDriveFile({ id: "gone", path: "/mix/lost.txt", body: "lost" });
    // Remove one file's R2 object while keeping its DB row (simulated inconsistency).
    await runtime.storage.from(buckets.drive).delete(`gone/${encodeURIComponent("lost.txt")}`);
    const { shareId, accessToken } = await seedFolderShare("/mix", "share-mix");

    const response = await app.request(`/api/public/s/${shareId}/download-zip`, {
      headers: { "x-access-token": accessToken },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Skipped-Count")).toBe("1");
    const text = new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));
    expect(text).toContain("_SKIPPED.txt"); // ZIP stores entry names in cleartext
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
