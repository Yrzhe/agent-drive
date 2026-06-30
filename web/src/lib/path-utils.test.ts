import { describe, expect, it } from "vitest";

import { getParentPath, joinPath, normalizePath } from "./path-utils";

describe("path utils", () => {
  it("normalizes empty, relative, duplicate-slash, and backslash paths", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("folder/file.txt")).toBe("/folder/file.txt");
    expect(normalizePath("//folder///file.txt/")).toBe("/folder/file.txt");
    expect(normalizePath("folder\\nested")).toBe("/folder/nested");
  });

  it("finds parent paths", () => {
    expect(getParentPath("/")).toBe("/");
    expect(getParentPath("/folder")).toBe("/");
    expect(getParentPath("/folder/file.txt")).toBe("/folder");
  });

  it("joins paths with sanitized names", () => {
    expect(joinPath("/", "new/folder")).toBe("/new-folder");
    expect(joinPath("/parent/", " child ")).toBe("/parent/child");
  });
});
