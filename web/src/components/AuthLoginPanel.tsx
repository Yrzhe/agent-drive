import { useEffect, useRef } from "react";
import { client } from "@/lib/edgespark";

interface AuthLoginPanelProps {
  redirectTo?: string;
}

export function AuthLoginPanel({ redirectTo = "/" }: AuthLoginPanelProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;
    container.innerHTML = "";
    const mounted = client.authUI.mount(container, { redirectTo }) as { destroy?: () => void } | undefined;
    return () => {
      mounted?.destroy?.();
      container.innerHTML = "";
    };
  }, [redirectTo]);

  return (
    <div className="mx-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold text-slate-900">Agent Drive</h1>
      <p className="mt-2 text-sm text-slate-600">Sign in to manage files and share links.</p>
      <div ref={mountRef} className="mt-6 min-h-40" />
    </div>
  );
}
