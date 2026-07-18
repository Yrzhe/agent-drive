import { useCallback, useEffect, useState } from "react";
import { apiFetchJson, DriveApiError } from "@/lib/api-client";
import type { AllowlistEntry } from "@/types/access";

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");
const formatDate = (value: string) => new Date(value).toLocaleString();

export function AllowlistSection() {
  const [entries, setEntries] = useState<AllowlistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyEmails, setBusyEmails] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetchJson<{ allowlist: AllowlistEntry[] }>("/api/public/v1/admin/allowlist");
      setEntries(result.allowlist);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markBusy = (email: string, busy: boolean) =>
    setBusyEmails((current) => {
      const next = new Set(current);
      if (busy) next.add(email);
      else next.delete(email);
      return next;
    });

  const handleAdd = async () => {
    const email = newEmail.trim();
    if (!email) return;
    setAdding(true);
    setAddError(null);
    try {
      await apiFetchJson("/api/public/v1/admin/allowlist", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setNewEmail("");
      await refresh();
    } catch (err) {
      if (err instanceof DriveApiError && (err.code === "invalid_email" || err.code === "validation_error")) {
        setAddError(err.message);
      } else {
        setAddError(getErrorMessage(err));
      }
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (email: string) => {
    markBusy(email, true);
    try {
      await apiFetchJson(`/api/public/v1/admin/allowlist/${encodeURIComponent(email)}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      markBusy(email, false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">Allowlist</h2>
      {error ? <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

      <div className="mb-3 flex flex-wrap items-start gap-2">
        <div className="min-w-[200px] flex-1">
          <input
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-blue-500"
            onChange={(event) => setNewEmail(event.target.value)}
            placeholder="email@example.com"
            type="email"
            value={newEmail}
          />
          {addError ? <div className="mt-1 text-xs text-red-600">{addError}</div> : null}
        </div>
        <button
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={adding || !newEmail.trim()}
          onClick={() => { void handleAdd(); }}
          type="button"
        >
          {adding ? "Adding..." : "Add"}
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-100">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-slate-200 text-left text-slate-600">
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Added by</th>
              <th className="px-3 py-2 font-medium">Added</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-3 py-4 text-slate-600" colSpan={4}>Loading...</td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-slate-500" colSpan={4}>No allowlisted emails.</td>
              </tr>
            ) : (
              entries.map((entry) => {
                const busy = busyEmails.has(entry.email);
                return (
                  <tr className="border-b border-slate-100" key={entry.email}>
                    <td className="px-3 py-2 text-slate-800">{entry.email}</td>
                    <td className="px-3 py-2 text-slate-700">{entry.addedBy}</td>
                    <td className="px-3 py-2 text-slate-600">{formatDate(entry.addedAt)}</td>
                    <td className="px-3 py-2">
                      <button
                        className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                        disabled={busy}
                        onClick={() => { void handleRemove(entry.email); }}
                        type="button"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
