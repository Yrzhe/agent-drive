import { afterAll, beforeEach, describe, expect, it } from "vitest";

import app from "../../src/index";
import { jsonHeaders, resetRuntime, runtime, seedDriveFile, useBearer } from "./edge-runtime";

async function rpc(headers: HeadersInit, method: string, params?: unknown): Promise<Response> {
  return app.request("/api/public/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("MCP Streamable HTTP transport methods", () => {
  beforeEach(() => {
    resetRuntime();
  });

  // Spec: the server MUST return text/event-stream OR 405 for GET. It must not
  // 404 — in MCP a 404 means "session terminated, re-initialize", which would
  // send Streamable HTTP clients into a needless re-init loop.
  it("answers GET with 405 (no SSE stream), not 404", async () => {
    const res = await app.request("/api/public/mcp", { method: "GET" });

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(await res.json()).toMatchObject({ error: "method_not_allowed" });
  });

  it("answers DELETE with 405 (no client-initiated session termination)", async () => {
    const res = await app.request("/api/public/mcp", { method: "DELETE" });

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});

describe("MCP agent-facing contract", () => {
  beforeEach(() => {
    resetRuntime();
  });

  afterAll(() => {
    runtime.sqlite?.close();
  });

  it("returns rich initialize instructions (scopes, path rule, text-vs-binary, errors)", async () => {
    const headers = jsonHeaders(useBearer(["read:drive", "write:drive", "share:create", "path:/"]));
    const body = await (await rpc(headers, "initialize")).json() as { result?: { instructions?: string } };
    const text = body.result?.instructions ?? "";

    expect(text).toContain("write:drive");
    expect(text).toContain('must start with "/"'); // absolute-path rule
    expect(text.toLowerCase()).toContain("text"); // write_file text-only guidance
    expect(text).toContain("guideUrl"); // hand-off note
    expect(text).toContain("-32001"); // scope error convention
    expect(text).toContain("/connect");
    // Binary-upload path must be the FULL absolute endpoint, not an abbreviated one.
    expect(text).toContain("/api/public/v1/files/upload/complete");
  });

  it("MCP create_share returns guideUrl for hand-off parity with REST", async () => {
    const headers = jsonHeaders(useBearer(["read:drive", "share:create", "path:/"]));
    await seedDriveFile({ id: "sharable", path: "/report.txt", body: "hi" });

    const response = await rpc(headers, "tools/call", { name: "create_share", arguments: { file_path: "/report.txt" } });
    const raw = await response.text();

    expect(raw).toContain("guideUrl");
    expect(raw).toContain("/api/public/guide");
    expect(raw).toContain("/s/"); // shareUrl still present
  });

  it("does not expose the removed read:skills / write:skills scopes on a granted token", async () => {
    // A bearer configured with a dead scope yields no tools (scope parse fails closed),
    // confirming read:skills is no longer a recognized MCP scope.
    const headers = jsonHeaders(useBearer(["read:drive", "read:skills", "path:/"]));
    const body = await (await rpc(headers, "tools/list")).json() as { result?: { tools?: unknown[] }; error?: unknown };
    // read:skills is not a valid scope → agentTokenScopes returns [] → no tools surfaced.
    expect(body.result?.tools ?? []).toHaveLength(0);
  });
});
