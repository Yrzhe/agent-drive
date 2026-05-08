import { describe, expect, it } from "vitest";

import { parseSize } from "../src/lib/size-parser.js";

describe("parseSize", () => {
  it("parses common units", () => {
    expect(parseSize("10MB", 0)).toBe(10 * 1024 * 1024);
    expect(parseSize("1GB", 0)).toBe(1024 ** 3);
    expect(parseSize("500KB", 0)).toBe(500 * 1024);
    expect(parseSize("10240", 0)).toBe(10240);
  });

  it("throws for invalid sizes", () => {
    expect(() => parseSize("abc", 0)).toThrow("Invalid size");
  });
});
