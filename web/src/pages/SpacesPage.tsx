import { useCallback, useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { AuthLoginPanel } from "@/components/AuthLoginPanel";
import { useAccessStatus } from "@/hooks/useAccessStatus";
import { useAuth } from "@/hooks/useAuth";
import { spacesApi } from "@/hooks/useSpaces";
import type { SpaceSummary } from "@/types/spaces";

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");

export default function SpacesPage() {
  const { user, loading: authLoading, isAuthenticated, signOut } = useAuth();
  const { status: accessStatus, loading: accessLoading, error: accessError, refetch: accessRefetch } = useAccessStatus();
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [newSpaceName, setNewSpaceName] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await spacesApi.listSpaces();
      setSpaces(result.spaces);
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

  const handleCreate = async () => {
    const name = newSpaceName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await spacesApi.createSpace(name);
      setNewSpaceName("");
      await refresh();
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  if (authLoading) return <main className="min-h-screen bg-slate-50 px-6 py-12"><div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">Checking auth status...</div></main>;
  if (!isAuthenticated) return <main className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 px-6 py-16"><AuthLoginPanel redirectTo="/spaces" /></main>;
  if (accessLoading) return <main className="min-h-screen bg-slate-50 px-6 py-12"><div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">Checking access status...</div></main>;
  if (!accessStatus) return <main className="min-h-screen bg-slate-50 px-6 py-12"><div className="mx-auto max-w-5xl space-y-3 rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">{accessError ? (<><p>{accessError}</p><button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={accessRefetch} type="button">Retry</button></>) : "Checking access status..."}</div></main>;
  if (accessStatus === "pending" || accessStatus === "suspended") return <Navigate replace to="/waitlist" />;

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Spaces</h1>
            <p className="text-sm text-slate-600">Current user: {user?.email ?? user?.name ?? "Unknown"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" to="/drive">← Back to Drive</Link>
            <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white" onClick={() => { void signOut(); }} type="button">Sign out</button>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-lg font-semibold text-slate-900">Create a space</h2>
          <p className="mb-3 text-sm text-slate-600">
            A space lets you share files, folders, and memory with invited members — by reference, not by copy. See the
            member panel inside a space for what "editor" access means for your real files.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              className="w-72 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500"
              onChange={(event) => setNewSpaceName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleCreate();
              }}
              placeholder="Space name"
              type="text"
              value={newSpaceName}
            />
            <button
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={creating || !newSpaceName.trim()}
              onClick={() => { void handleCreate(); }}
              type="button"
            >
              {creating ? "Creating..." : "Create space"}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-lg font-semibold text-slate-900">My spaces</h2>
          {errorMessage ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</div> : null}
          <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-slate-100">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-slate-200 text-left text-slate-600">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Your role</th>
                  <th className="px-3 py-2 font-medium">Members</th>
                  <th className="px-3 py-2 font-medium">Items</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td className="px-3 py-4 text-slate-600" colSpan={6}>Loading...</td></tr>
                ) : spaces.length === 0 ? (
                  <tr><td className="px-3 py-4 text-slate-500" colSpan={6}>You're not in any spaces yet. Create one above.</td></tr>
                ) : (
                  spaces.map((space) => (
                    <tr className="border-b border-slate-100" key={space.id}>
                      <td className="px-3 py-2 font-medium text-slate-900">{space.name}</td>
                      <td className="px-3 py-2 text-slate-700">{space.role}</td>
                      <td className="px-3 py-2 text-slate-700">{space.memberCount}</td>
                      <td className="px-3 py-2 text-slate-700">{space.itemCount}</td>
                      <td className="px-3 py-2 text-slate-600">{new Date(space.createdAt).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <Link className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" to={`/spaces/${space.id}`}>
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
