import { describe, expect, it } from "vitest";

import { escapedDescendantPattern, relativePath } from "./paths";

describe("path helpers", () => {
  it("escapes SQL LIKE wildcards in descendant patterns", () => {
    expect(escapedDescendantPattern("/team_100%/notes\\drafts")).toBe("/team\\_100\\%/notes\\\\drafts/%");
  });

  it("keeps root descendant pattern broad", () => {
    expect(escapedDescendantPattern("/")).toBe("/%");
  });

  it("computes normalized relative paths under a base path", () => {
    expect(relativePath("/bundle/src/index.ts", "/bundle")).toBe("src/index.ts");
    expect(relativePath("/top.txt", "/")).toBe("top.txt");
  });
});
