import { useCallback, useEffect, useState } from "react";
import { apiFetchJson } from "@/lib/api-client";
import type { WaitlistEntry } from "@/types/access";

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");
const formatDate = (value: string) => new Date(value).toLocaleString();

export function WaitlistSection() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetchJson<{ waitlist: WaitlistEntry[] }>("/api/public/v1/admin/waitlist");
      setEntries(result.waitlist);
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

  const markBusy = (id: string, busy: boolean) =>
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleDecision = async (userId: string, decision: "approve" | "reject") => {
    markBusy(userId, true);
    try {
      await apiFetchJson(`/api/public/v1/admin/waitlist/${encodeURIComponent(userId)}/${decision}`, { method: "POST" });
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      markBusy(userId, false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">Waitlist</h2>
      {error ? <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-100">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-slate-200 text-left text-slate-600">
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Message</th>
              <th className="px-3 py-2 font-medium">Referred by</th>
              <th className="px-3 py-2 font-medium">Applied</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-3 py-4 text-slate-600" colSpan={6}>Loading...</td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-slate-500" colSpan={6}>No pending applicants.</td>
              </tr>
            ) : (
              entries.map((entry) => {
                const busy = busyIds.has(entry.userId);
                return (
                  <tr className="border-b border-slate-100" key={entry.userId}>
                    <td className="px-3 py-2 text-slate-800">{entry.email ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-700">{entry.name ?? "—"}</td>
                    <td className="max-w-xs truncate px-3 py-2 text-slate-700" title={entry.message ?? undefined}>
                      {entry.message ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{entry.referredBy ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{formatDate(entry.appliedAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <button
                          className="rounded border border-green-300 px-2 py-1 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => { void handleDecision(entry.userId, "approve"); }}
                          type="button"
                        >
                          Approve
                        </button>
                        <button
                          className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => { void handleDecision(entry.userId, "reject"); }}
                          type="button"
                        >
                          Reject
                        </button>
                      </div>
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
