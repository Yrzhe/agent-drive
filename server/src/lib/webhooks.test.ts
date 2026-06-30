import { afterEach, describe, expect, it, vi } from "vitest";

import { validateWebhookUrl, validateWebhookUrlForDelivery } from "./webhooks";

function dnsResponse(records: Array<{ type: number; data: string }>): Response {
  return new Response(JSON.stringify({ Status: 0, Answer: records }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("webhook URL validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("blocks local and internal hostnames including trailing dots", () => {
    expect(validateWebhookUrl("https://localhost./hook")).toContain("localhost");
    expect(validateWebhookUrl("https://api.internal./hook")).toContain("internal");
    expect(validateWebhookUrl("http://example.com/hook")).toContain("https");
  });

  it("fails closed when DNS does not resolve safely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => dnsResponse([])));

    await expect(validateWebhookUrlForDelivery("https://example.com/hook")).resolves.toContain("did not resolve");
  });

  it("blocks private or reserved DNS answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const query = new URL(url).searchParams;
      return query.get("type") === "A"
        ? dnsResponse([{ type: 1, data: "127.0.0.1" }])
        : dnsResponse([{ type: 28, data: "2001:db8::1" }]);
    }));

    await expect(validateWebhookUrlForDelivery("https://example.com/hook")).resolves.toContain("private or reserved");
  });

  it("blocks private or reserved AAAA answers even with a public A answer", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const query = new URL(url).searchParams;
      return query.get("type") === "A"
        ? dnsResponse([{ type: 1, data: "93.184.216.34" }])
        : dnsResponse([{ type: 28, data: "fe90::1" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateWebhookUrlForDelivery("https://example.com/hook")).resolves.toContain("private or reserved");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts public DNS answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const query = new URL(url).searchParams;
      return query.get("type") === "A"
        ? dnsResponse([{ type: 1, data: "93.184.216.34" }])
        : dnsResponse([]);
    }));

    await expect(validateWebhookUrlForDelivery("https://example.com/hook")).resolves.toBeNull();
  });
});
