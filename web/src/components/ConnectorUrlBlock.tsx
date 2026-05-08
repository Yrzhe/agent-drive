import { useEffect, useState } from "react";

export function ConnectorUrlBlock({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Connector URL</h2>
          <p className="mt-1 text-sm text-slate-600">Use this URL in Claude, Codex, Cursor, or any Remote MCP client.</p>
        </div>
        <button
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          onClick={() => { void handleCopy(); }}
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <code className="mt-4 block overflow-x-auto rounded-lg bg-slate-950 px-3 py-2 text-sm text-slate-100">{url}</code>
    </section>
  );
}
