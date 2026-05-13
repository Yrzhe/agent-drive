import { describe, expect, it } from "vitest";

import { validateScopeString, KNOWN_OAUTH_SCOPES } from "../src/lib/oauth.js";

describe("validateScopeString", () => {
  it("accepts the default scope string", () => {
    expect(validateScopeString("read:drive write:drive share:create"))
      .toBe("read:drive write:drive share:create");
  });

  it("accepts every known scope on its own", () => {
    for (const scope of KNOWN_OAUTH_SCOPES) {
      expect(validateScopeString(scope)).toBe(scope);
    }
  });

  it("dedupes repeated scope tokens", () => {
    expect(validateScopeString("read:drive read:drive write:drive"))
      .toBe("read:drive write:drive");
  });

  it("collapses whitespace", () => {
    expect(validateScopeString("  read:drive    write:drive  "))
      .toBe("read:drive write:drive");
  });

  it("throws on empty input", () => {
    expect(() => validateScopeString("")).toThrow("--scope must not be empty");
    expect(() => validateScopeString("   ")).toThrow("--scope must not be empty");
  });

  it("throws on unknown scope tokens, naming them", () => {
    expect(() => validateScopeString("read:drive admin:everything"))
      .toThrow(/Unknown OAuth scope/);
    expect(() => validateScopeString("read:drive admin:everything"))
      .toThrow(/admin:everything/);
  });

  it("rejects malformed scope-like inputs", () => {
    expect(() => validateScopeString("write::drive")).toThrow(/Unknown/);
    expect(() => validateScopeString("read:everything")).toThrow(/Unknown/);
  });
});
