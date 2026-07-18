/**
 * Access-status hook — fetches the caller's multi-user access status once
 * authenticated. Only meaningful after `useAuth().isAuthenticated`; while
 * unauthenticated it never fetches and returns a neutral idle state.
 *
 * Usage:
 *   const { status, isAdmin, email, loading, error, refetch } = useAccessStatus();
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { apiFetchJson } from "@/lib/api-client";
import type { AccessStatus } from "@/types/access";

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed. Please try again.");

export function useAccessStatus() {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      setStatus(null);
      setIsAdmin(false);
      setEmail(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setError(null);
    void apiFetchJson<{ status: AccessStatus; email: string | null; isAdmin: boolean }>("/api/public/v1/account/status")
      .then((result) => {
        if (cancelled) return;
        setStatus(result.status);
        setIsAdmin(result.isAdmin);
        setEmail(result.email);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(getErrorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [authLoading, isAuthenticated, refreshToken]);

  // Derived (not stored) so the very first render after `isAuthenticated` flips true
  // is already `loading: true` — no one-tick gap where a stale `status: null` could be
  // read as "resolved" by a caller before the fetch has even started.
  const loading = authLoading || (isAuthenticated && status === null && error === null);

  const refetch = useCallback(() => setRefreshToken((token) => token + 1), []);

  return { status, isAdmin, email, loading, error, refetch };
}
