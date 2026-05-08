import { useEffect, useState } from "react";
import { getSnippet, type McpPlatform } from "@/lib/mcp-snippets";

interface PlatformTab {
  id: McpPlatform;
  label: string;
}

const TABS: PlatformTab[] = [
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "claude-code", label: "Claude Code CLI" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex CLI" },
  { id: "generic", label: "Generic / JSON-RPC" },
];

function CopySnippetButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  };

  return (
    <button
      className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      onClick={() => { void handleCopy(); }}
      type="button"
    >
      {copied ? "Copied" : "Copy snippet"}
    </button>
  );
}

export function PlatformTabs({ connectorUrl, scope }: { connectorUrl: string; scope: string }) {
  const [activeTab, setActiveTab] = useState<McpPlatform>("claude-desktop");
  const snippet = getSnippet(activeTab, connectorUrl, scope);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">Platform setup</h2>
      <div className="mt-4 flex flex-wrap gap-2 border-b border-slate-200 pb-3">
        {TABS.map((tab) => (
          <button
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${activeTab === tab.id ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-4">
        {activeTab === "claude-desktop" ? (
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
            <li>Open Claude Desktop settings.</li>
            <li>Go to Connectors.</li>
            <li>Add a custom connector.</li>
            <li>Paste the connector URL below and complete the browser authorization flow.</li>
          </ol>
        ) : null}
        {activeTab === "generic" ? (
          <p className="text-sm text-slate-600">The selected scope string is included for advanced OAuth clients: <code className="rounded bg-slate-100 px-1 py-0.5">{scope}</code></p>
        ) : null}

        <div className="rounded-lg border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Snippet</span>
            <CopySnippetButton value={snippet} />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap p-3 text-sm text-slate-800"><code>{snippet}</code></pre>
        </div>
      </div>
    </section>
  );
}
