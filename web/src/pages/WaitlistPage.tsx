import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { AuthLoginPanel } from "@/components/AuthLoginPanel";
import { useAccessStatus } from "@/hooks/useAccessStatus";
import { useAuth } from "@/hooks/useAuth";
import { apiFetchJson } from "@/lib/api-client";

const MAX_MESSAGE_CHARS = 500;
const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");

export default function WaitlistPage() {
  const { loading: authLoading, isAuthenticated, signOut } = useAuth();
  const { status, isAdmin, loading: accessLoading, error: accessError, refetch } = useAccessStatus();
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    setSubmitted(false);
    try {
      const trimmed = message.trim();
      await apiFetchJson("/api/public/v1/account/apply", {
        method: "POST",
        body: JSON.stringify(trimmed ? { message: trimmed } : {}),
      });
      setSubmitted(true);
      refetch();
    } catch (error) {
      setSubmitError(getErrorMessage(error));
    } finally {
      setSubmitting(false);
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
        <AuthLoginPanel redirectTo="/waitlist" />
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
  if (status === "active") return <Navigate replace to="/drive" />;

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          <h1 className="text-xl font-semibold text-slate-900">Agent Drive</h1>
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin ? (
              <Link className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" to="/admin">
                Admin console
              </Link>
            ) : null}
            <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white" onClick={() => { void signOut(); }} type="button">
              Sign out
            </button>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          {status === "suspended" ? (
            <>
              <h2 className="text-lg font-semibold text-slate-900">Access is not available</h2>
              <p className="mt-2 text-sm text-slate-600">Your account has been suspended. Access is not available at this time.</p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-slate-900">You&apos;re on the waitlist</h2>
              <p className="mt-2 text-sm text-slate-600">An admin will review your request. You&apos;ll gain access once approved.</p>

              <div className="mt-4 space-y-2">
                <label className="block text-sm font-medium text-slate-700" htmlFor="waitlist-message">
                  Message to the admin (optional)
                </label>
                <textarea
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
                  id="waitlist-message"
                  maxLength={MAX_MESSAGE_CHARS}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Why do you need access?"
                  rows={4}
                  value={message}
                />
                <div className="text-xs text-slate-500">
                  {message.length} / {MAX_MESSAGE_CHARS}
                </div>
                {submitError ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{submitError}</div> : null}
                {submitted && !submitError ? (
                  <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">Message sent.</div>
                ) : null}
                <button
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  disabled={submitting}
                  onClick={() => { void handleSubmit(); }}
                  type="button"
                >
                  {submitting ? "Submitting..." : "Submit"}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
