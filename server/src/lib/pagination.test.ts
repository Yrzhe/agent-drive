import { describe, expect, it } from "vitest";

import { parseListPagination } from "./pagination";

const query = (map: Record<string, string>) => (name: string) => map[name];

describe("parseListPagination", () => {
  it("applies defaults and clamps to bounds", () => {
    expect(parseListPagination(query({}), { defaultLimit: 100, maxLimit: 500 })).toEqual({ limit: 100, offset: 0 });
    expect(parseListPagination(query({ limit: "50", offset: "10" }), { defaultLimit: 100, maxLimit: 500 })).toEqual({ limit: 50, offset: 10 });
    expect(parseListPagination(query({ limit: "9999" }), { defaultLimit: 100, maxLimit: 500 }).limit).toBe(500);
    expect(parseListPagination(query({ limit: "0" }), { defaultLimit: 100, maxLimit: 500 }).limit).toBe(1);
    expect(parseListPagination(query({ offset: "-5" }), { defaultLimit: 100, maxLimit: 500 }).offset).toBe(0);
  });

  it("falls back on garbage input", () => {
    expect(parseListPagination(query({ limit: "abc", offset: "xyz" }), { defaultLimit: 100, maxLimit: 500 })).toEqual({ limit: 100, offset: 0 });
  });
});
