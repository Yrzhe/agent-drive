import { describe, expect, it } from "vitest";

import { describeOAuthScope, parseOAuthScopes } from "./oauth-scopes";

describe("oauth scope helpers", () => {
  it("parses and deduplicates scope strings", () => {
    expect(parseOAuthScopes(" read:drive  write:drive read:drive ")).toEqual(["read:drive", "write:drive"]);
    expect(parseOAuthScopes(null)).toEqual([]);
  });

  it("describes known capability scopes", () => {
    expect(describeOAuthScope("share:create")).toMatchObject({
      scope: "share:create",
      title: "创建分享链接 / Create share links",
    });
  });

  it("describes path scopes", () => {
    const root = describeOAuthScope("path:/");
    expect(root.title).toContain("Path-restricted");
    expect(root.description).toContain("entire drive");

    const subtree = describeOAuthScope("path:/projects/demo/*");
    expect(subtree.description).toContain("/projects/demo/");
  });

  it("falls back for unknown scopes", () => {
    expect(describeOAuthScope("custom:unknown").title).toContain("Unknown permission");
  });
});
