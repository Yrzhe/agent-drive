import { Link, Navigate } from "react-router-dom";
import { AuthLoginPanel } from "@/components/AuthLoginPanel";
import { AllowlistSection } from "@/components/admin/AllowlistSection";
import { UsersSection } from "@/components/admin/UsersSection";
import { WaitlistSection } from "@/components/admin/WaitlistSection";
import { useAccessStatus } from "@/hooks/useAccessStatus";
import { useAuth } from "@/hooks/useAuth";

export default function AdminPage() {
  const { user, loading: authLoading, isAuthenticated, signOut } = useAuth();
  const { status, isAdmin, loading: accessLoading, error: accessError } = useAccessStatus();

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
        <AuthLoginPanel redirectTo="/admin" />
      </main>
    );
  }
  if (accessLoading) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-12">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">Checking access status...</div>
      </main>
    );
  }
  if (!status) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-12">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">
          {accessError ?? "Checking access status..."}
        </div>
      </main>
    );
  }
  if (!isAdmin) return <Navigate replace to="/drive" />;

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Admin Console</h1>
            <p className="text-sm text-slate-600">Current user: {user?.email ?? user?.name ?? "Unknown"}</p>
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

        <WaitlistSection />
        <AllowlistSection />
        <UsersSection />
      </div>
    </main>
  );
}
