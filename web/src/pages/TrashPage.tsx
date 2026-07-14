import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AuthLoginPanel } from "@/components/AuthLoginPanel";
import { useAuth } from "@/hooks/useAuth";
import { driveApi } from "@/lib/drive-api";
import type { DriveFile } from "@/types/drive";

type TrashEntry = DriveFile & {
  deletedAt: string | null;
  retention: { deletedAt: string; purgesAt: string; daysLeft: number } | null;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

const formatDate = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");
const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");

export default function TrashPage() {
  const { user, loading: authLoading, isAuthenticated, signOut } = useAuth();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await driveApi.listTrash();
      setEntries(result.files);
      setRetentionDays(result.retentionDays);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refresh();
  }, [isAuthenticated, refresh]);

  const markBusy = (id: string, busy: boolean) =>
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleRestore = async (entry: TrashEntry) => {
    markBusy(entry.id, true);
    try {
      await driveApi.restoreFile(entry.id);
      setEntries((current) => current.filter((e) => e.id !== entry.id));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      markBusy(entry.id, false);
    }
  };

  const handlePurge = async (entry: TrashEntry) => {
    const label = entry.isFolder ? `folder "${entry.name}" and everything inside` : `"${entry.name}"`;
    if (!window.confirm(`Permanently delete ${label}? This cannot be undone.`)) return;
    markBusy(entry.id, true);
    try {
      await driveApi.purgeFile(entry.id);
      setEntries((current) => current.filter((e) => e.id !== entry.id));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      markBusy(entry.id, false);
    }
  };

  if (authLoading) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-12">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">Checking auth status...</div>
      </main>
    );
  }
  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 px-6 py-16">
        <AuthLoginPanel redirectTo="/trash" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Trash</h1>
            <p className="text-sm text-slate-600">
              Deleted items are kept for {retentionDays} days, then permanently removed. {user?.email ?? user?.name ?? ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" to="/drive">
              ← Back to Drive
            </Link>
            <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white" onClick={() => { void signOut(); }} type="button">
              Sign out
            </button>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          {errorMessage ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</div> : null}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-600">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">Size</th>
                  <th className="py-2 pr-4 font-medium">Deleted</th>
                  <th className="py-2 pr-4 font-medium">Auto-purge in</th>
                  <th className="py-2 pr-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td className="py-4 text-slate-600" colSpan={6}>Loading…</td></tr>
                ) : entries.length === 0 ? (
                  <tr><td className="py-4 text-slate-500" colSpan={6}>Trash is empty.</td></tr>
                ) : (
                  entries.map((entry) => {
                    const busy = busyIds.has(entry.id);
                    return (
                      <tr className="border-b border-slate-100" key={entry.id}>
                        <td className="py-2 pr-4">
                          <span className="text-slate-800">
                            {entry.isFolder ? "📁" : "📄"} {entry.name}
                          </span>
                          <div className="text-xs text-slate-500">{entry.path}</div>
                        </td>
                        <td className="py-2 pr-4 text-slate-700">{entry.isFolder ? "Folder" : entry.contentType || "File"}</td>
                        <td className="py-2 pr-4 text-slate-700">{entry.isFolder ? "—" : formatBytes(entry.size)}</td>
                        <td className="py-2 pr-4 text-slate-600">{formatDate(entry.deletedAt)}</td>
                        <td className="py-2 pr-4 text-slate-600">
                          {entry.retention ? `${entry.retention.daysLeft} day${entry.retention.daysLeft === 1 ? "" : "s"}` : "—"}
                        </td>
                        <td className="py-2 pr-4">
                          <div className="flex flex-wrap gap-2">
                            <button
                              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                              disabled={busy}
                              onClick={() => { void handleRestore(entry); }}
                              type="button"
                            >
                              Restore
                            </button>
                            <button
                              className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                              disabled={busy}
                              onClick={() => { void handlePurge(entry); }}
                              type="button"
                            >
                              Delete forever
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
      </div>
    </main>
  );
}
