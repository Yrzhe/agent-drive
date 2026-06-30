import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthLoginPanel } from "@/components/AuthLoginPanel";
import { ConsentScopeList } from "@/components/ConsentScopeList";
import { useAuth } from "@/hooks/useAuth";
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

type ConsentResponse = {
  redirect_uri?: string;
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

export default function ConnectAuthorizePage() {
  const search = window.location.search;
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);
  const clientId = searchParams.get("client_id") ?? "";
  const redirectUri = searchParams.get("redirect_uri");
  const scopeDescriptions = useMemo(
    () => parseOAuthScopes(searchParams.get("scope")).map(describeOAuthScope),
    [searchParams],
  );
  const { loading: authLoading, isAuthenticated } = useAuth();
  const [clientInfo, setClientInfo] = useState<OAuthClientInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submittingAction, setSubmittingAction] = useState<"allow" | "deny" | null>(null);

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

  const clientName = clientInfo?.clientName ?? "MCP Client";
  const csrfToken = clientInfo?.csrfToken ?? "";

  const submitConsent = useCallback(async (approved: boolean) => {
    if (!clientId || !redirectUri) {
      setErrorMessage(`Cannot ${approved ? "authorize" : "deny"} this request because client_id or redirect_uri is missing.`);
      return;
    }
    setSubmittingAction(approved ? "allow" : "deny");
    setErrorMessage(null);
    try {
      const body = Object.fromEntries(searchParams.entries());
      const result = await apiFetchJson<ConsentResponse>(`/api/public/oauth/authorize/consent${search}`, {
        method: "POST",
        body: JSON.stringify({
          ...body,
          approved: approved ? "true" : "false",
          csrf_token: csrfToken,
          csrfToken,
        }),
      });
      if (!result.redirect_uri) {
        throw new DriveApiError("Authorization response did not include redirect_uri.", 500, "MISSING_REDIRECT_URI");
      }
      window.location.assign(result.redirect_uri);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : approved ? "Authorization failed." : "Deny failed.");
      setSubmittingAction(null);
    }
  }, [clientId, csrfToken, redirectUri, search, searchParams]);

  if (authLoading) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-10">
        <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">Checking auth status...</div>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 px-6 py-16">
        <AuthLoginPanel redirectTo={`${window.location.pathname}${window.location.search}`} />
      </main>
    );
  }

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
            disabled={loading || submittingAction !== null}
            onClick={() => { void submitConsent(false); }}
            type="button"
          >
            {submittingAction === "deny" ? "Denying..." : "拒绝 / Deny"}
          </button>
          <button
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            disabled={!clientId || !redirectUri || loading || submittingAction !== null}
            onClick={() => { void submitConsent(true); }}
            type="button"
          >
            {submittingAction === "allow" ? "Authorizing..." : "同意 / Allow"}
          </button>
        </section>
      </div>
    </main>
  );
}
