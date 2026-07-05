import { describe, expect, it } from "vitest";

import { requiredRestScope } from "./rest-scopes";

describe("requiredRestScope", () => {
  it("maps reads to read:drive", () => {
    expect(requiredRestScope("GET", "/api/public/v1/files")).toBe("read:drive");
    expect(requiredRestScope("get", "/api/public/v1/shares")).toBe("read:drive");
    expect(requiredRestScope("HEAD", "/api/public/v1/bundles/current")).toBe("read:drive");
    expect(requiredRestScope("GET", "/api/public/v1/activity")).toBe("read:drive");
    expect(requiredRestScope("GET", "/api/public/v1/stats")).toBe("read:drive");
  });

  it("maps share mutations to share:create", () => {
    expect(requiredRestScope("POST", "/api/public/v1/shares")).toBe("share:create");
    expect(requiredRestScope("DELETE", "/api/public/v1/shares/abc123")).toBe("share:create");
  });

  it("does not treat share-prefixed non-share paths as share routes", () => {
    expect(requiredRestScope("POST", "/api/public/v1/sharesx")).toBe("write:drive");
  });

  it("maps memory routes to memory scopes", () => {
    expect(requiredRestScope("GET", "/api/public/v1/memory")).toBe("read:memory");
    expect(requiredRestScope("GET", "/api/public/v1/memory/search")).toBe("read:memory");
    expect(requiredRestScope("POST", "/api/public/v1/memory")).toBe("write:memory");
    expect(requiredRestScope("DELETE", "/api/public/v1/memory/abc")).toBe("write:memory");
  });

  it("maps every other mutation to write:drive", () => {
    expect(requiredRestScope("POST", "/api/public/v1/files/upload")).toBe("write:drive");
    expect(requiredRestScope("PATCH", "/api/public/v1/files/abc")).toBe("write:drive");
    expect(requiredRestScope("DELETE", "/api/public/v1/files/abc")).toBe("write:drive");
    expect(requiredRestScope("POST", "/api/public/v1/folders")).toBe("write:drive");
    expect(requiredRestScope("POST", "/api/public/v1/bundles/commit")).toBe("write:drive");
    expect(requiredRestScope("POST", "/api/public/v1/webhooks")).toBe("write:drive");
    expect(requiredRestScope("DELETE", "/api/public/v1/webhooks/abc")).toBe("write:drive");
  });
});
