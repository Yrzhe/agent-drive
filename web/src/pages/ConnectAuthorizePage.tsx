import { useCallback, useEffect, useMemo, useState } from "react";
import { ConsentScopeList } from "@/components/ConsentScopeList";
import { DriveApiError, apiFetchJson } from "@/lib/api-client";
import { describeOAuthScope, parseOAuthScopes } from "@/lib/oauth-scopes";

interface OAuthClientInfo {
  clientId: string;
  clientName: string;
  csrfToken: string;
  source: "api" | "fallback";
}

type OAuthClientInfoResponse = {
  client?: {
    id?: string;
    clientId?: string;
    client_id?: string;
    clientName?: string;
    client_name?: string;
    name?: string;
  };
  id?: string;
  client_id?: string;
  clientName?: string;
  client_name?: string;
  name?: string;
  csrfToken?: string;
  csrf_token?: string;
};

function readClientName(payload: OAuthClientInfoResponse, clientId: string): string {
  return payload.client?.clientName
    ?? payload.client?.client_name
    ?? payload.client?.name
    ?? payload.clientName
    ?? payload.client_name
    ?? payload.name
    ?? clientId
    ?? "MCP Client";
}

function readClientId(payload: OAuthClientInfoResponse, fallback: string): string {
  return payload.client?.clientId
    ?? payload.client?.id
    ?? payload.client?.client_id
    ?? payload.client_id
    ?? payload.id
    ?? fallback;
}

function readCsrfToken(payload: OAuthClientInfoResponse, searchParams: URLSearchParams): string {
  return payload.csrfToken ?? payload.csrf_token ?? searchParams.get("csrf_token") ?? searchParams.get("csrfToken") ?? "";
}

function buildDeniedRedirect(redirectUri: string | null, state: string | null): string | null {
  if (!redirectUri) return null;
  try {
    const url = new URL(redirectUri, window.location.origin);
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);
    return url.toString();
  } catch {
    return null;
  }
}

export default function ConnectAuthorizePage() {
  const search = window.location.search;
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);
  const clientId = searchParams.get("client_id") ?? "";
  const redirectUri = searchParams.get("redirect_uri");
  const state = searchParams.get("state");
  const scopeDescriptions = useMemo(
    () => parseOAuthScopes(searchParams.get("scope")).map(describeOAuthScope),
    [searchParams],
  );
  const hiddenParams = useMemo(() => Array.from(searchParams.entries()), [searchParams]);
  const deniedRedirect = useMemo(() => buildDeniedRedirect(redirectUri, state), [redirectUri, state]);
  const [clientInfo, setClientInfo] = useState<OAuthClientInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadClientInfo() {
      setLoading(true);
      setErrorMessage(null);
      try {
        if (!clientId) throw new DriveApiError("Missing OAuth client_id", 400, "MISSING_CLIENT_ID");
        const payload = await apiFetchJson<OAuthClientInfoResponse>(`/api/public/oauth/clients/${encodeURIComponent(clientId)}`);
        if (cancelled) return;
        setClientInfo({
          clientId: readClientId(payload, clientId),
          clientName: readClientName(payload, clientId),
          csrfToken: readCsrfToken(payload, searchParams),
          source: "api",
        });
      } catch (error) {
        if (cancelled) return;
        setClientInfo({
          clientId: clientId || "unknown-client",
          clientName: clientId || "MCP Client",
          csrfToken: searchParams.get("csrf_token") ?? searchParams.get("csrfToken") ?? "",
          source: "fallback",
        });
        setErrorMessage(error instanceof Error ? error.message : "Unable to load OAuth client information.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadClientInfo();
    return () => {
      cancelled = true;
    };
  }, [clientId, searchParams]);

  const handleDeny = useCallback(() => {
    if (deniedRedirect) {
      window.location.assign(deniedRedirect);
      return;
    }
    setErrorMessage("Cannot deny this request because redirect_uri is missing or invalid.");
  }, [deniedRedirect]);

  const clientName = clientInfo?.clientName ?? "MCP Client";
  const csrfToken = clientInfo?.csrfToken ?? "";

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-medium text-blue-700">Agent Drive MCP Connection</p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-950">Authorize {clientName}</h1>
          <p className="mt-2 text-sm text-slate-600">
            Review every permission below before connecting this MCP client to your Agent Drive account.
          </p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="space-y-1 text-sm">
            <div className="flex flex-wrap justify-between gap-3">
              <span className="text-slate-500">Client</span>
              <span className="font-medium text-slate-900">{clientName}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-3">
              <span className="text-slate-500">Client ID</span>
              <code className="break-all text-xs text-slate-700">{clientInfo?.clientId ?? (clientId || "-")}</code>
            </div>
            <div className="flex flex-wrap justify-between gap-3">
              <span className="text-slate-500">Redirect URI</span>
              <code className="break-all text-xs text-slate-700">{redirectUri ?? "-"}</code>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-base font-semibold text-slate-900">Requested permissions</h2>
          <ConsentScopeList scopes={scopeDescriptions} />
        </section>

        {loading ? <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">Loading client details...</div> : null}
        {errorMessage ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {clientInfo?.source === "fallback" ? "Using temporary client details. " : null}{errorMessage}
          </div>
        ) : null}

        <section className="flex flex-wrap items-center justify-end gap-3 rounded-xl border border-slate-200 bg-white p-5">
          <button
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={handleDeny}
            type="button"
          >
            拒绝 / Deny
          </button>
          <form action={`/api/public/oauth/authorize/consent${search}`} method="post">
            {hiddenParams.map(([key, value], index) => (
              <input key={`${key}-${index}`} name={key} type="hidden" value={value} />
            ))}
            <input name="approved" type="hidden" value="true" />
            <input name="csrf_token" type="hidden" value={csrfToken} />
            <input name="csrfToken" type="hidden" value={csrfToken} />
            <button
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              disabled={!clientId || !redirectUri || loading}
              type="submit"
            >
              同意 / Allow
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
