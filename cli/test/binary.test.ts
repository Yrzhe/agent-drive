import { describe, expect, it } from "vitest";

import { isBinaryContent } from "../src/lib/binary.js";

describe("isBinaryContent", () => {
  it("returns false for utf8 text", () => {
    expect(isBinaryContent(Buffer.from("hello\nworld\n", "utf8"))).toBe(false);
  });

  it("returns true for PNG-like bytes", () => {
    expect(isBinaryContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe(true);
  });

  it("returns true for text containing NUL", () => {
    expect(isBinaryContent(Buffer.from("hello\0world", "utf8"))).toBe(true);
  });
});
