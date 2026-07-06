import { describe, expect, it } from "vitest";

import { INBOX_MAX_FILE_BYTES, decodeInboxContent, inboxTargetFolder, parseInboxPayload } from "./peering";

const validBody = {
  from: "https://peer.example.com/",
  filename: "report.pdf",
  contentType: "application/pdf",
  contentBase64: "aGVsbG8=",
  message: "  here you go  ",
  sentAt: new Date().toISOString(),
};

describe("parseInboxPayload", () => {
  it("normalizes a valid payload", () => {
    const payload = parseInboxPayload(validBody);
    expect(payload.from).toBe("https://peer.example.com");
    expect(payload.filename).toBe("report.pdf");
    expect(payload.message).toBe("here you go");
  });

  it("rejects stale timestamps (replay window)", () => {
    expect(() => parseInboxPayload({ ...validBody, sentAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() })).toThrow("window");
    expect(() => parseInboxPayload({ ...validBody, sentAt: "not-a-date" })).toThrow("sentAt");
  });

  it("rejects missing required fields", () => {
    expect(() => parseInboxPayload({ ...validBody, from: "" })).toThrow("from");
    expect(() => parseInboxPayload({ ...validBody, filename: " " })).toThrow("filename");
    expect(() => parseInboxPayload({ ...validBody, contentBase64: "" })).toThrow("contentBase64");
  });
});

describe("decodeInboxContent", () => {
  it("decodes base64 and enforces the size cap", () => {
    expect(new TextDecoder().decode(decodeInboxContent("aGVsbG8="))).toBe("hello");
    const oversized = btoa("x".repeat(INBOX_MAX_FILE_BYTES + 1));
    expect(() => decodeInboxContent(oversized)).toThrow("exceeds");
    expect(() => decodeInboxContent("!!not-base64!!")).toThrow("base64");
  });
});

describe("inboxTargetFolder", () => {
  it("quarantines untrusted contacts and releases trusted ones", () => {
    expect(inboxTargetFolder({ name: "bob", autoRelease: 0 })).toBe("/inbox/pending/bob");
    expect(inboxTargetFolder({ name: "bob", autoRelease: 1 })).toBe("/inbox/bob");
  });
});
