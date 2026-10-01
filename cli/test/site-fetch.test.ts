import { afterEach, describe, expect, it, vi } from "vitest";
import { siteFetch } from "../src/lib/site-fetch.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("private Sites service credential", () => {
  it("sends the platform header only to the explicitly configured origin", async () => {
    vi.stubEnv("ADRIVE_SITES_URL", "https://drive.example");
    vi.stubEnv("ADRIVE_SITES_AUTHORIZATION", "test-platform-credential");
    const fetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    await siteFetch("https://drive.example/api/public/mcp", { headers: { authorization: "Bearer application-token" } });
    const options = fetch.mock.calls[0][1];
    expect(options.headers.get("authorization")).toBe("Bearer application-token");
    expect(options.headers.get("OAI-Sites-Authorization")).toBe("Bearer test-platform-credential");
    expect(options.redirect).toBe("manual");
    await siteFetch("https://other.example/object");
    expect(fetch.mock.calls[1][1]).toBeUndefined();
  });
  it("refuses redirects without sending a second request", async () => {
    vi.stubEnv("ADRIVE_SITES_URL", "https://drive.example");
    vi.stubEnv("ADRIVE_SITES_AUTHORIZATION", "test-platform-credential");
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(siteFetch("https://drive.example/api")).rejects.toThrow("redirected");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
