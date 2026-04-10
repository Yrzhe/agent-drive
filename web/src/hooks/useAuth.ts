/**
 * Auth hook — subscribes to session changes via onSessionChange().
 *
 * Usage:
 *   const { user, loading, isAuthenticated, signOut } = useAuth();
 */

import { useEffect, useState } from "react";
import { client } from "@/lib/edgespark";
import type { AuthSession } from "@edgespark/web";

export function useAuth() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = client.auth.onSessionChange((nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  return {
    user: session?.user ?? null,
    session,
    loading,
    isAuthenticated: !!session,
    signOut: () => client.auth.signOut(),
  };
}
