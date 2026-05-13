import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forgetBundleSync, readBundleSyncEntry, recordBundleSync } from "../src/lib/sync-state.js";

let homeBackup: string | undefined;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "adrive-state-"));
  homeBackup = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (homeBackup === undefined) delete process.env.HOME;
  else process.env.HOME = homeBackup;
  await rm(home, { recursive: true, force: true });
});

describe("sync-state", () => {
  it("returns null when no entry exists", async () => {
    const entry = await readBundleSyncEntry("/local/path", "/cloud/path");
    expect(entry).toBeNull();
  });

  it("records and reads a bundle sync entry", async () => {
    await recordBundleSync({
      localPath: "/local/path",
      cloudPrefix: "/cloud/path",
      lastSeenVersionId: "dv_abc123",
      lastSeenHash: "sha256-abc",
    });
    const entry = await readBundleSyncEntry("/local/path", "/cloud/path");
    expect(entry).toMatchObject({
      cloudPrefix: "/cloud/path",
      lastSeenVersionId: "dv_abc123",
      lastSeenHash: "sha256-abc",
    });
    expect(entry?.updatedAt).toBeTruthy();
  });

  it("isolates entries by localPath + cloudPrefix", async () => {
    await recordBundleSync({
      localPath: "/a",
      cloudPrefix: "/x",
      lastSeenVersionId: "dv_aaa",
      lastSeenHash: "h1",
    });
    await recordBundleSync({
      localPath: "/b",
      cloudPrefix: "/x",
      lastSeenVersionId: "dv_bbb",
      lastSeenHash: "h2",
    });
    const aEntry = await readBundleSyncEntry("/a", "/x");
    const bEntry = await readBundleSyncEntry("/b", "/x");
    expect(aEntry?.lastSeenVersionId).toBe("dv_aaa");
    expect(bEntry?.lastSeenVersionId).toBe("dv_bbb");
  });

  it("forgets a single entry without affecting others", async () => {
    await recordBundleSync({
      localPath: "/a",
      cloudPrefix: "/x",
      lastSeenVersionId: "dv_aaa",
      lastSeenHash: "h1",
    });
    await recordBundleSync({
      localPath: "/b",
      cloudPrefix: "/x",
      lastSeenVersionId: "dv_bbb",
      lastSeenHash: "h2",
    });
    await forgetBundleSync("/a", "/x");
    expect(await readBundleSyncEntry("/a", "/x")).toBeNull();
    expect((await readBundleSyncEntry("/b", "/x"))?.lastSeenVersionId).toBe("dv_bbb");
  });
});
