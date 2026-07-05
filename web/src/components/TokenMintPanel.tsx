import { useCallback, useEffect, useState } from "react";
import { DriveApiError } from "@/lib/api-client";
import { driveApi, type DriveToken } from "@/lib/drive-api";
import { OAUTH_SCOPE_DESCRIPTIONS } from "@/lib/oauth-scopes";

const MINTABLE_SCOPES = ["read:drive", "write:drive", "share:create", "read:memory", "write:memory"] as const;
const DEFAULT_MINT_SCOPES = ["read:drive", "write:drive"];
const EXPIRY_OPTIONS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

function formatDate(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : iso;
}

function tokenStatus(token: DriveToken): { text: string; className: string } {
  if (token.revokedAt) return { text: "revoked", className: "bg-red-100 text-red-700" };
  if (token.expired) return { text: "expired", className: "bg-amber-100 text-amber-800" };
  return { text: "active", className: "bg-green-100 text-green-800" };
}

export function TokenMintPanel() {
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_MINT_SCOPES);
  const [pathPrefix, setPathPrefix] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sessionRequired, setSessionRequired] = useState(false);
  const [tokens, setTokens] = useState<DriveToken[]>([]);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const refreshTokens = useCallback(async () => {
    try {
      const result = await driveApi.listTokens();
      setTokens(result.tokens);
      setSessionRequired(false);
    } catch (error) {
      if (error instanceof DriveApiError && error.status === 403) {
        setSessionRequired(true);
        return;
      }
      if (error instanceof DriveApiError && error.status === 401) {
        setSessionRequired(true);
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : "Failed to load tokens.");
    }
  }, []);

  useEffect(() => {
    void refreshTokens();
  }, [refreshTokens]);

  const toggleScope = (scope: string) => {
    setScopes((current) => (current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]));
  };

  const handleMint = async () => {
    if (scopes.length === 0) {
      setErrorMessage("Select at least one scope.");
      return;
    }
    setMinting(true);
    setErrorMessage(null);
    setMintedToken(null);
    setCopied(false);
    try {
      const result = await driveApi.mintToken({
        label: label.trim() || undefined,
        scopes,
        pathPrefix: pathPrefix.trim() || undefined,
        expiresInDays,
      });
      setMintedToken(result.token);
      setLabel("");
      await refreshTokens();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to mint token.");
    } finally {
      setMinting(false);
    }
  };

  const handleCopy = async () => {
    if (!mintedToken) return;
    try {
      await navigator.clipboard.writeText(mintedToken);
      setCopied(true);
    } catch {
      setErrorMessage("Clipboard unavailable — copy the token manually.");
    }
  };

  const handleRevoke = async (tokenId: string) => {
    setRevokingId(tokenId);
    setErrorMessage(null);
    try {
      await driveApi.revokeToken(tokenId);
      await refreshTokens();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to revoke token.");
    } finally {
      setRevokingId(null);
    }
  };

  if (sessionRequired) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-900">Scoped drive tokens</h2>
        <p className="mt-2 text-sm text-slate-600">
          Sign in as the owner to mint scoped bearer tokens. Token minting is session-only by design — agents cannot mint new tokens with a bearer token.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">Scoped drive tokens</h2>
      <p className="mt-1 text-sm text-slate-600">
        Mint a bearer token limited to selected capabilities and an optional path prefix — hand it to a third-party agent without the OAuth flow. Revocable any time.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-slate-900" htmlFor="token-label">Label</label>
          <input
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            id="token-label"
            maxLength={64}
            onChange={(event) => { setLabel(event.target.value); }}
            placeholder="e.g. research-agent"
            type="text"
            value={label}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-900" htmlFor="token-expiry">Expires in</label>
          <select
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
            id="token-expiry"
            onChange={(event) => { setExpiresInDays(Number(event.target.value)); }}
            value={expiresInDays}
          >
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.days} value={option.days}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {MINTABLE_SCOPES.map((scope) => (
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm" key={scope}>
            <input checked={scopes.includes(scope)} className="mt-0.5" onChange={() => { toggleScope(scope); }} type="checkbox" />
            <span>
              <span className="block font-medium text-slate-900">{scope}</span>
              <span className="text-xs text-slate-600">{OAUTH_SCOPE_DESCRIPTIONS[scope]?.description ?? ""}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-3">
        <label className="block text-sm font-medium text-slate-900" htmlFor="token-path-prefix">Path restriction (optional)</label>
        <input
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 font-mono text-sm"
          id="token-path-prefix"
          onChange={(event) => { setPathPrefix(event.target.value); }}
          placeholder="/handoffs"
          type="text"
          value={pathPrefix}
        />
        <p className="mt-1 text-xs text-slate-500">Limits file operations to this subtree. Memory scopes are not path-restricted.</p>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={minting}
          onClick={() => { void handleMint(); }}
          type="button"
        >
          {minting ? "Minting..." : "Mint token"}
        </button>
        {errorMessage ? <p className="text-sm text-red-600">{errorMessage}</p> : null}
      </div>

      {mintedToken ? (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3">
          <p className="text-sm font-medium text-green-900">Token minted — shown once, save it now:</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 text-xs text-slate-800">{mintedToken}</code>
            <button
              className="rounded-lg border border-green-300 px-3 py-1.5 text-sm text-green-800 hover:bg-green-100"
              onClick={() => { void handleCopy(); }}
              type="button"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-xs text-green-800">Use it as <code>Authorization: Bearer &lt;token&gt;</code> against MCP and REST.</p>
        </div>
      ) : null}

      {tokens.length > 0 ? (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3">Label</th>
                <th className="py-2 pr-3">Scopes</th>
                <th className="py-2 pr-3">Expires</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const status = tokenStatus(token);
                return (
                  <tr className="border-b border-slate-100" key={token.id}>
                    <td className="py-2 pr-3 font-medium text-slate-900">{token.label ?? token.id.slice(0, 12)}</td>
                    <td className="max-w-[280px] py-2 pr-3 font-mono text-xs text-slate-600">{token.scopes.join(" ")}</td>
                    <td className="py-2 pr-3 text-slate-600">{formatDate(token.expiresAt)}</td>
                    <td className="py-2 pr-3">
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${status.className}`}>{status.text}</span>
                    </td>
                    <td className="py-2 text-right">
                      {!token.revokedAt ? (
                        <button
                          className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                          disabled={revokingId === token.id}
                          onClick={() => { void handleRevoke(token.id); }}
                          type="button"
                        >
                          {revokingId === token.id ? "Revoking..." : "Revoke"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
