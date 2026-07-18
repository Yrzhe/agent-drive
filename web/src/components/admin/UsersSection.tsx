import { useCallback, useEffect, useState } from "react";
import { apiFetchJson, DriveApiError } from "@/lib/api-client";
import type { AdminUser } from "@/types/access";

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");

export function UsersSection() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [actionErrors, setActionErrors] = useState<Record<string, string | undefined>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetchJson<{ users: AdminUser[] }>("/api/public/v1/admin/users");
      setUsers(result.users);
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

  const handleToggle = async (user: AdminUser) => {
    const action = user.status === "suspended" ? "unsuspend" : "suspend";
    markBusy(user.userId, true);
    setActionErrors((current) => ({ ...current, [user.userId]: undefined }));
    try {
      await apiFetchJson(`/api/public/v1/admin/users/${encodeURIComponent(user.userId)}/${action}`, { method: "POST" });
      await refresh();
    } catch (err) {
      const message = err instanceof DriveApiError && err.code === "cannot_suspend_owner" ? err.message : getErrorMessage(err);
      setActionErrors((current) => ({ ...current, [user.userId]: message }));
    } finally {
      markBusy(user.userId, false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">Users</h2>
      {error ? <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-100">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-slate-200 text-left text-slate-600">
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-3 py-4 text-slate-600" colSpan={4}>Loading...</td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-slate-500" colSpan={4}>No users yet.</td>
              </tr>
            ) : (
              users.map((user) => {
                const busy = busyIds.has(user.userId);
                const actionError = actionErrors[user.userId];
                return (
                  <tr className="border-b border-slate-100" key={user.userId}>
                    <td className="px-3 py-2 text-slate-800">{user.email ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-700">{user.name ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-700">{user.status}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          disabled={busy}
                          onClick={() => { void handleToggle(user); }}
                          type="button"
                        >
                          {user.status === "suspended" ? "Unsuspend" : "Suspend"}
                        </button>
                        {actionError ? <span className="text-xs text-red-600">{actionError}</span> : null}
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
