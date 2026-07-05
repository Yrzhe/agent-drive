import { describe, expect, it } from "vitest";

import { buildFtsMatchQuery, normalizeMemoryKey, parseTags, serializeTags, validateMemoryContent } from "./memory";

describe("buildFtsMatchQuery", () => {
  it("quotes each token with a prefix wildcard", () => {
    expect(buildFtsMatchQuery("deploy edgespark")).toBe('"deploy" * "edgespark" *');
  });

  it("neutralizes FTS5 operators and quotes", () => {
    expect(buildFtsMatchQuery('NEAR(a b) OR "x"')).toBe('"NEAR(a" * "b)" * "OR" * "x" *');
  });

  it("returns empty string for blank input", () => {
    expect(buildFtsMatchQuery("   ")).toBe("");
  });
});

describe("tags round-trip", () => {
  it("serializes deduped trimmed tags and parses them back", () => {
    const raw = serializeTags([" project ", "project", "deploy", 42, ""]);
    expect(raw).toBe(JSON.stringify(["project", "deploy"]));
    expect(parseTags(raw)).toEqual(["project", "deploy"]);
  });

  it("caps tag count and tag length", () => {
    const many = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
    expect(JSON.parse(serializeTags(many)!)).toHaveLength(32);
    expect(JSON.parse(serializeTags(["x".repeat(100)])!)[0]).toHaveLength(64);
  });

  it("returns null/empty for non-arrays and bad JSON", () => {
    expect(serializeTags("not-an-array")).toBeNull();
    expect(serializeTags([])).toBeNull();
    expect(parseTags("{broken")).toEqual([]);
    expect(parseTags(null)).toEqual([]);
  });
});

describe("input validation", () => {
  it("normalizes keys and rejects oversized ones", () => {
    expect(normalizeMemoryKey("  project:decisions  ")).toBe("project:decisions");
    expect(normalizeMemoryKey(undefined)).toBeNull();
    expect(normalizeMemoryKey("")).toBeNull();
    expect(() => normalizeMemoryKey("x".repeat(257))).toThrow("invalid_params");
  });

  it("rejects empty and oversized content", () => {
    expect(() => validateMemoryContent("")).toThrow("invalid_params");
    expect(() => validateMemoryContent("x".repeat(9 * 1024))).toThrow("invalid_params");
    expect(validateMemoryContent("remember this")).toBe("remember this");
  });
});
