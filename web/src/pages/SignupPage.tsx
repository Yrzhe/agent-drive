import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { client } from "@/lib/edgespark";
import { apiFetchJson } from "@/lib/api-client";

// Part ③ agent-native registration hand-off: a recipient's agent mints a short-lived
// intent (POST /api/public/register/start, Task 1) and hands the human a
// `/signup?token=...` link. This page reads the token, pre-fills what the intent knows
// (email + optional name), and renders a normal signup form for the human to complete.
// The intent NEVER carries a password — the human types it here, and it goes straight to
// Better Auth's `signUp.email` and nowhere else. If the token is missing, expired, or
// already consumed, the intent lookup 404s and the form falls back to a blank signup with
// no pre-fill.

interface RegistrationIntent {
  email: string;
  name: string | null;
  ref: string | null;
}

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong. Please try again.");

export default function SignupPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [intentLoading, setIntentLoading] = useState(!!token);
  const [intent, setIntent] = useState<RegistrationIntent | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!token) {
      setIntentLoading(false);
      return;
    }
    let cancelled = false;
    setIntentLoading(true);
    apiFetchJson<RegistrationIntent>(`/api/public/register/intent/${encodeURIComponent(token)}`)
      .then((result) => {
        if (cancelled) return;
        setIntent(result);
        setEmail(result.email);
        if (result.name) setName(result.name);
      })
      .catch(() => {
        if (cancelled) return;
        // Missing/expired/consumed token (404), or any other lookup failure — fall back
        // to a plain signup form with no pre-fill either way, per the brief.
        setIntent(null);
      })
      .finally(() => {
        if (!cancelled) setIntentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async () => {
    setSubmitError(null);
    if (!name.trim()) {
      setSubmitError("Name is required.");
      return;
    }
    if (!email.trim()) {
      setSubmitError("Email is required.");
      return;
    }
    if (password.length < 8) {
      setSubmitError("Password must be at least 8 characters.");
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await client.auth.signUp.email({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      if (error) {
        setSubmitError(error.message ?? "Sign-up failed. Please try again.");
        return;
      }
      setSubmitted(true);
    } catch (error) {
      setSubmitError(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (intentLoading) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-12">
        <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-slate-600">Loading...</div>
      </main>
    );
  }

  if (submitted) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-12">
        <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-6">
          <h1 className="text-xl font-semibold text-slate-900">Check your email</h1>
          <p className="mt-2 text-sm text-slate-600">
            We sent a verification link to <span className="font-medium text-slate-900">{email}</span>. Click it to finish setting up
            your account.
          </p>
          <Link className="mt-6 inline-block text-sm font-medium text-blue-600 hover:text-blue-700" to="/">
            Back to home
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 px-6 py-16">
      <div className="mx-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Agent Drive</h1>
        <p className="mt-2 text-sm text-slate-600">
          {intent
            ? "An agent invited you. Finish setting up your account below."
            : "Create an account to manage files and share links."}
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="signup-name">
              Name
            </label>
            <input
              autoComplete="name"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
              id="signup-name"
              onChange={(event) => setName(event.target.value)}
              type="text"
              value={name}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="signup-email">
              Email
            </label>
            <input
              autoComplete="email"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
              id="signup-email"
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="signup-password">
              Password
            </label>
            <input
              autoComplete="new-password"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
              id="signup-password"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSubmit();
              }}
              placeholder="At least 8 characters"
              type="password"
              value={password}
            />
          </div>

          {submitError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{submitError}</div>
          ) : null}

          <button
            className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={submitting}
            onClick={() => {
              void handleSubmit();
            }}
            type="button"
          >
            {submitting ? "Creating account..." : "Create account"}
          </button>
        </div>

        <p className="mt-6 text-center text-sm text-slate-600">
          Already have an account?{" "}
          <Link className="font-medium text-blue-600 hover:text-blue-700" to="/waitlist">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
