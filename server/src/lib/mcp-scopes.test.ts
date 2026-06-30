import { describe, expect, it } from "vitest";

import { formatPathScope, normalizeScopes, parsePathScope, pathAllowed } from "./mcp-scopes";

describe("MCP path scopes", () => {
  it("normalizes path scopes into canonical wildcard form", () => {
    expect(normalizeScopes(["read:drive", "path:/projects/demo/", "path:/projects/demo/*"])).toEqual([
      "read:drive",
      "path:/projects/demo/*",
    ]);
    expect(formatPathScope("/")).toBe("path:/");
  });

  it("rejects malformed path scopes", () => {
    expect(parsePathScope("path:relative")).toBeNull();
    expect(parsePathScope("path:/safe/../secret")).toBeNull();
    expect(parsePathScope("path:/safe/*/secret")).toBeNull();
  });

  it("allows only exact or descendant paths when path scopes are present", () => {
    const scopes = ["read:drive", "path:/allowed/*"];
    expect(pathAllowed(scopes, "/allowed")).toBe(true);
    expect(pathAllowed(scopes, "/allowed/file.txt")).toBe(true);
    expect(pathAllowed(scopes, "/allowedish/file.txt")).toBe(false);
    expect(pathAllowed(scopes, "/")).toBe(false);
  });
});
