import { describe, expect, it } from "vitest";

import { TRASH_PATH_MARKER, displayTrashPath, originalTrashPath, tombstonePathFor } from "./trash";

describe("tombstone paths", () => {
  it("round-trips a trashed root path", () => {
    const tomb = tombstonePathFor("/reports", "abc_123-XYZ");
    expect(tomb).toBe(`/reports${TRASH_PATH_MARKER}abc_123-XYZ`);
    expect(originalTrashPath({ path: tomb, id: "abc_123-XYZ" })).toBe("/reports");
  });

  it("leaves legacy trashed paths (no marker) unchanged", () => {
    expect(originalTrashPath({ path: "/reports", id: "abc" })).toBe("/reports");
  });

  it("does not strip a marker that belongs to a different root id", () => {
    const tomb = tombstonePathFor("/reports", "rootA");
    expect(originalTrashPath({ path: tomb, id: "rootB" })).toBe(tomb);
  });

  it("strips markers from descendant paths for display", () => {
    const tombRoot = tombstonePathFor("/a", "id1");
    expect(displayTrashPath(`${tombRoot}/b/c.txt`)).toBe("/a/b/c.txt");
    expect(displayTrashPath(tombRoot)).toBe("/a");
    expect(displayTrashPath("/plain/path.txt")).toBe("/plain/path.txt");
  });
});
