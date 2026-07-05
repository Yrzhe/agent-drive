import { describe, expect, it } from "vitest";

import { validateExpiresDays, validateMintScopes, validatePathPrefix } from "./tokens";

describe("validateMintScopes", () => {
  it("accepts and dedupes mintable scopes", () => {
    expect(validateMintScopes(["read:drive", "read:drive", "write:memory"])).toEqual(["read:drive", "write:memory"]);
  });

  it("rejects empty, unknown, and non-mintable scopes", () => {
    expect(() => validateMintScopes([])).toThrow("non-empty array");
    expect(() => validateMintScopes(["root:everything"])).toThrow("Unknown or non-mintable");
    expect(() => validateMintScopes(["read:skills"])).toThrow("Unknown or non-mintable");
    expect(() => validateMintScopes(["path:/foo"])).toThrow("Unknown or non-mintable");
  });
});

describe("validatePathPrefix", () => {
  it("normalizes plain paths and path: scopes", () => {
    expect(validatePathPrefix("/handoffs")).toBe("/handoffs");
    expect(validatePathPrefix("path:/handoffs/*")).toBe("/handoffs");
    expect(validatePathPrefix("/")).toBe("/");
    expect(validatePathPrefix(undefined)).toBeNull();
    expect(validatePathPrefix("")).toBeNull();
  });

  it("rejects traversal and glob tricks", () => {
    expect(() => validatePathPrefix("/a/../b")).toThrow("pathPrefix");
    expect(() => validatePathPrefix("/a//b")).toThrow("pathPrefix");
    expect(() => validatePathPrefix("/a*b")).toThrow("pathPrefix");
  });

  it("rejects whitespace that would broaden the grant when scopes re-split", () => {
    expect(() => validatePathPrefix("/My Documents")).toThrow("pathPrefix");
    expect(() => validatePathPrefix("/ x")).toThrow("pathPrefix");
    expect(() => validatePathPrefix("/a b")).toThrow("pathPrefix");
  });
});

describe("validateExpiresDays", () => {
  it("defaults to 90 and bounds 1..365", () => {
    expect(validateExpiresDays(undefined)).toBe(90);
    expect(validateExpiresDays(30)).toBe(30);
    expect(() => validateExpiresDays(0)).toThrow("expiresInDays");
    expect(() => validateExpiresDays(400)).toThrow("expiresInDays");
    expect(() => validateExpiresDays(1.5)).toThrow("expiresInDays");
  });
});
