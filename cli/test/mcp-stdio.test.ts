import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../dist/index.js", import.meta.url));

interface CapturedRequest {
  method: string;
  authorization: string | undefined;
  body: string;
}

interface StubServer {
  url: string;
  requests: CapturedRequest[];
  setResponder(fn: (req: IncomingMessage, body: string, res: ServerResponse) => void): void;
  close(): Promise<void>;
}

async function startStub(): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let responder: (req: IncomingMessage, body: string, res: ServerResponse) => void = (_req, body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: (JSON.parse(body) as { id?: unknown }).id ?? null, result: { ok: true } }));
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        authorization: req.headers.authorization,
        body,
      });
      responder(req, body, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setResponder(fn) { responder = fn; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface BridgeRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runBridge(configDir: string, lines: string[]): Promise<BridgeRun> {
  return new Promise<BridgeRun>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, "mcp", "stdio"], {
      env: { ...process.env, HOME: configDir, USERPROFILE: configDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));

    for (const line of lines) {
      child.stdin.write(`${line}\n`);
    }
    child.stdin.end();
  });
}

let stub: StubServer;
let home: string;

beforeEach(async () => {
  stub = await startStub();
  home = await mkdtemp(join(tmpdir(), "adrive-stdio-"));
  const configDir = join(home, ".agent-drive");
  await writeFile(join(home, "skip"), "", { flag: "a" });
  await import("node:fs/promises").then(({ mkdir }) => mkdir(configDir, { recursive: true, mode: 0o700 }));
  const config = {
    version: 1,
    url: stub.url,
    token: "test-token-abc",
    tokenType: "agent_token",
    machineId: "mach-test",
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(configDir, "config.json"), JSON.stringify(config, null, 2));
});

afterEach(async () => {
  await stub.close();
  await rm(home, { recursive: true, force: true });
});

describe("adrive mcp stdio", () => {
  it("forwards a JSON-RPC request and emits the response with original id", async () => {
    stub.setResponder((_req, body, res) => {
      const parsed = JSON.parse(body) as { id: number };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { hello: "world" } }));
    });

    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 42, method: "initialize", params: {} });
    const { stdout, stderr, exitCode } = await runBridge(home, [initialize]);

    expect(exitCode).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].authorization).toBe("Bearer test-token-abc");
    expect(JSON.parse(stub.requests[0].body)).toMatchObject({ id: 42, method: "initialize" });

    const responseLines = stdout.trim().split("\n").filter((line) => line.length > 0);
    expect(responseLines).toHaveLength(1);
    expect(JSON.parse(responseLines[0])).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: { hello: "world" },
    });

    expect(stderr).toContain("-> initialize");
  });

  it("returns a JSON-RPC parse error for malformed input without crashing", async () => {
    const { stdout, exitCode } = await runBridge(home, ["{ not json"]);

    expect(exitCode).toBe(0);
    const responseLines = stdout.trim().split("\n").filter((line) => line.length > 0);
    expect(responseLines).toHaveLength(1);
    const response = JSON.parse(responseLines[0]) as { id: null; error: { code: number } };
    expect(response.id).toBeNull();
    expect(response.error.code).toBe(-32700);
  });

  it("returns a JSON-RPC network error response on remote failure", async () => {
    stub.setResponder((_req, _body, res) => {
      res.destroy();
    });

    const request = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
    const { stdout, exitCode } = await runBridge(home, [request]);

    expect(exitCode).toBe(0);
    const responseLines = stdout.trim().split("\n").filter((line) => line.length > 0);
    expect(responseLines).toHaveLength(1);
    const response = JSON.parse(responseLines[0]) as { id: number; error: { code: number; message: string } };
    expect(response.id).toBe(7);
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toMatch(/network error/);
  });

  it("does not emit a response for JSON-RPC notifications (no id)", async () => {
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const { stdout, exitCode } = await runBridge(home, [notification]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(stub.requests).toHaveLength(1);
  });
});
