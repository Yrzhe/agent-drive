import { describe, expect, it } from "vitest";
import { chatGptDownloadUrl, fetchChatGptFile } from "./chatgpt-files";

describe("ChatGPT attachment sources", () => {
  it("accepts temporary official file and image URLs", () => {
    expect(chatGptDownloadUrl("https://files.oaiusercontent.com/file.png?sig=secret").hostname).toBe("files.oaiusercontent.com");
    expect(chatGptDownloadUrl("https://oaidalleapiprodscus.blob.core.windows.net/image.png?sig=secret").protocol).toBe("https:");
  });
  it("rejects local paths, arbitrary hosts, deceptive suffixes and credentials", () => {
    for (const url of ["sandbox:/mnt/data/poster.png", "file_123", "http://files.oaiusercontent.com/a", "https://127.0.0.1/a", "https://[::1]/a", "https://files.oaiusercontent.com.evil.example/a", "https://user:secret@files.oaiusercontent.com/a", "https://files.oaiusercontent.com:8443/a", "https://example.com/a", "https://files.oaiusercontent.com/a#secret"]) {
      expect(() => chatGptDownloadUrl(url)).toThrow();
    }
  });
  it("validates redirects before fetching a new host", async () => {
    const fetched: string[] = [];
    const fetcher = (async (url: URL) => {
      fetched.push(url.hostname);
      return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
    }) as unknown as typeof fetch;
    await expect(fetchChatGptFile({ file_id: "file_test", download_url: "https://files.oaiusercontent.com/input" }, new AbortController().signal, fetcher)).rejects.toThrow("temporary HTTPS attachment");
    expect(fetched).toEqual(["files.oaiusercontent.com"]);
  });
  it("follows approved relative redirects without forwarding caller credentials", async () => {
    const fetched: string[] = [];
    const fetcher = (async (url: URL, options: RequestInit) => {
      fetched.push(url.pathname);
      expect(options.redirect).toBe("manual");
      expect(new Headers(options.headers).has("authorization")).toBe(false);
      return fetched.length === 1 ? new Response(null, { status: 302, headers: { location: "/final" } }) : new Response("bytes");
    }) as unknown as typeof fetch;
    const response = await fetchChatGptFile({ file_id: "file_test", download_url: "https://files.oaiusercontent.com/start" }, new AbortController().signal, fetcher);
    expect(await response.text()).toBe("bytes");
    expect(fetched).toEqual(["/start", "/final"]);
  });
  it("does not expose signed source URLs in network errors", async () => {
    const fetcher = (async () => { throw new Error("https://files.oaiusercontent.com/a?sig=private-signature"); }) as unknown as typeof fetch;
    await expect(fetchChatGptFile({ file_id: "file_test", download_url: "https://files.oaiusercontent.com/a?sig=private-signature" }, new AbortController().signal, fetcher)).rejects.toThrow("Unable to download");
  });
});
