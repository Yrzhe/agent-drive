import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ConnectorUrlBlock } from "@/components/ConnectorUrlBlock";
import { PlatformTabs } from "@/components/PlatformTabs";
import { OAUTH_SCOPE_DESCRIPTIONS } from "@/lib/oauth-scopes";

const ALL_SCOPES = ["read:drive", "write:drive", "share:create", "read:memory", "write:memory", "read:skills", "write:skills"] as const;
const DEFAULT_SCOPES = new Set<string>(["read:drive", "write:drive", "share:create"]);
const UNIMPLEMENTED_SCOPES = new Set<string>(["read:memory", "write:memory", "read:skills", "write:skills"]);
const API_DOCS_URL = "https://github.com/Yrzhe/agent-drive/tree/main/docs/api";
const SCOPE_STORAGE_KEY = "agent-drive:connect:selected-scopes";

function loadStoredScopes(): string[] | null {
  try {
    const raw = window.localStorage.getItem(SCOPE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const allowed = new Set<string>(ALL_SCOPES);
    return parsed.filter((value): value is string => typeof value === "string" && allowed.has(value));
  } catch {
    return null;
  }
}

type TestStatus =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function getOrigin(): string {
  return window.location.origin;
}

function findLocalBearerToken(): string | null {
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !/token|session|auth/i.test(key)) continue;
    const value = localStorage.getItem(key);
    if (!value) continue;
    if (/^[A-Za-z0-9._~-]{20,}$/u.test(value)) return value;
    try {
      const parsed = JSON.parse(value) as unknown;
      const token = findTokenInValue(parsed);
      if (token) return token;
    } catch {
      // Ignore non-JSON localStorage values.
    }
  }
  return null;
}

function findTokenInValue(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = findTokenInValue(item);
      if (token) return token;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (/accessToken|sessionToken|bearerToken|token/u.test(key) && typeof item === "string" && item.length >= 20) return item;
    const nested = findTokenInValue(item);
    if (nested) return nested;
  }
  return null;
}

function parseInitializeResult(payload: unknown): { name?: string; version?: string; protocolVersion?: string } {
  if (!payload || typeof payload !== "object") return {};
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object") return {};
  const serverInfo = (result as { serverInfo?: unknown }).serverInfo;
  return {
    protocolVersion: typeof (result as { protocolVersion?: unknown }).protocolVersion === "string" ? (result as { protocolVersion: string }).protocolVersion : undefined,
    name: serverInfo && typeof serverInfo === "object" && typeof (serverInfo as { name?: unknown }).name === "string" ? (serverInfo as { name: string }).name : undefined,
    version: serverInfo && typeof serverInfo === "object" && typeof (serverInfo as { version?: unknown }).version === "string" ? (serverInfo as { version: string }).version : undefined,
  };
}

export default function ConnectSetupPage() {
  const origin = getOrigin();
  const connectorUrl = `${origin}/api/public/mcp`;
  const protectedResourceUrl = `${origin}/api/public/.well-known/oauth-protected-resource`;
  const authorizationServerUrl = `${origin}/api/public/.well-known/oauth-authorization-server`;
  const [selectedScopes, setSelectedScopes] = useState<string[]>(() => loadStoredScopes() ?? ALL_SCOPES.filter((scope) => DEFAULT_SCOPES.has(scope)));
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle", message: "Run a quick probe to confirm the MCP endpoint is reachable." });
  const scopeString = useMemo(() => selectedScopes.join(" "), [selectedScopes]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify(selectedScopes));
    } catch {
      // localStorage disabled (private mode); ignore.
    }
  }, [selectedScopes]);

  const toggleScope = (scope: string) => {
    setSelectedScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]);
  };

  const handleTestConnection = async () => {
    setTestStatus({ kind: "idle", message: "Testing MCP endpoint..." });
    const token = findLocalBearerToken();
    try {
      const response = await fetch(connectorUrl, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });

      if (response.status === 401 && response.headers.get("www-authenticate")) {
        setTestStatus({ kind: "success", message: "Endpoint reachable, OAuth required as expected." });
        return;
      }

      if (response.ok) {
        const payload = await response.json().catch(() => null) as unknown;
        const info = parseInitializeResult(payload);
        setTestStatus({
          kind: "success",
          message: `Connected to ${info.name ?? "MCP server"}${info.version ? ` v${info.version}` : ""}${info.protocolVersion ? ` · protocol ${info.protocolVersion}` : ""}.`,
        });
        return;
      }

      setTestStatus({ kind: "error", message: `Endpoint responded with HTTP ${response.status}.` });
    } catch (error) {
      setTestStatus({ kind: "error", message: error instanceof Error ? error.message : "Connection test failed." });
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="rounded-xl border border-slate-200 bg-white p-6">
          <p className="text-sm font-medium text-blue-700">Agent Drive MCP</p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-950">Connect your AI agent</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Add Agent Drive as a Remote MCP connector so your AI tools can read, write, and share files through your own deployment.
          </p>
        </header>

        <ConnectorUrlBlock url={connectorUrl} />
        <PlatformTabs connectorUrl={connectorUrl} scope={scopeString} />

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">Scope picker</h2>
          <p className="mt-1 text-sm text-slate-600">Drive scopes are active today. Memory and skills scopes are reserved for upcoming sync features (use the <code>adrive</code> CLI for now).</p>
          <p className="mt-1 text-sm text-slate-600">These scopes are inserted into the Generic / JSON-RPC snippet for advanced OAuth setup.</p>
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {ALL_SCOPES.map((scope) => {
              const isPlanned = UNIMPLEMENTED_SCOPES.has(scope);
              return (
                <label className="flex items-start gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm" key={scope}>
                  <input
                    checked={selectedScopes.includes(scope)}
                    className="mt-1"
                    onChange={() => toggleScope(scope)}
                    type="checkbox"
                  />
                  <span>
                    <span className="block font-medium text-slate-900">
                      {scope}
                      {isPlanned ? <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">planned</span> : null}
                    </span>
                    <span className="text-slate-600">
                      {OAUTH_SCOPE_DESCRIPTIONS[scope]?.description ?? "Custom MCP scope."}
                      {isPlanned ? " No MCP tool consumes this scope yet — sync via the adrive CLI today." : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Test connection</h2>
              <p className="mt-1 text-sm text-slate-600">Probe the MCP endpoint from this browser.</p>
            </div>
            <button
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              onClick={() => { void handleTestConnection(); }}
              type="button"
            >
              Test connection
            </button>
          </div>
          <div className={`mt-4 rounded-lg border px-3 py-2 text-sm ${testStatus.kind === "success" ? "border-green-200 bg-green-50 text-green-800" : testStatus.kind === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>
            {testStatus.kind === "success" ? "✓ " : null}{testStatus.message}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">Discovery documents</h2>
          <div className="mt-3 space-y-2 rounded-lg bg-slate-950 p-3 text-sm">
            <a className="block break-all font-mono text-slate-100 underline decoration-slate-500 underline-offset-4" href={protectedResourceUrl} rel="noreferrer" target="_blank">{protectedResourceUrl}</a>
            <a className="block break-all font-mono text-slate-100 underline decoration-slate-500 underline-offset-4" href={authorizationServerUrl} rel="noreferrer" target="_blank">{authorizationServerUrl}</a>
          </div>
        </section>

        <details className="rounded-xl border border-slate-200 bg-white p-5">
          <summary className="cursor-pointer text-base font-semibold text-slate-900">AGENT_TOKEN bypass for self-hosted single-user mode</summary>
          <p className="mt-3 text-sm text-slate-600">
            Self-hosted single-user deployments can use AGENT_TOKEN as a Bearer token to bypass the OAuth browser flow.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-950 p-3 text-sm text-slate-100"><code>{`export AGENT_TOKEN="<your-agent-token>"
curl -s "${connectorUrl}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $AGENT_TOKEN" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`}</code></pre>
        </details>

        <footer className="flex flex-wrap items-center gap-3 text-sm">
          <Link className="rounded-lg border border-slate-300 px-3 py-2 text-slate-700 hover:bg-white" to="/guide">Browse all MCP tools</Link>
          <a className="rounded-lg border border-slate-300 px-3 py-2 text-slate-700 hover:bg-white" href={API_DOCS_URL} rel="noreferrer" target="_blank">API reference</a>
        </footer>
      </div>
    </main>
  );
}
