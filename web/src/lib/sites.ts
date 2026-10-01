export const deploymentPlatform: "edgespark" | "sites" = "sites";
export interface AuthSession {
  user: { id: string; email: string; name: string | null; image: string | null };
}
export function authPath(action: "signin" | "signout", returnTo: string): string {
  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") && !/[\\\r\n]/u.test(returnTo) ? returnTo : "/drive";
  return `/${action}-with-chatgpt?return_to=${encodeURIComponent(safe)}`;
}
function navigateTop(href: string) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_top";
  link.click();
}
export const client = {
  api: { fetch: (input: string, init?: RequestInit) => fetch(input, { ...init, credentials: "same-origin" }) },
  auth: {
    onSessionChange(callback: (session: AuthSession | null) => void) {
      const abort = new AbortController();
      fetch("/api/public/session", { credentials: "same-origin", cache: "no-store", signal: abort.signal })
        .then(async (response) => { if (!response.ok) throw new Error("Unable to load session"); return response.json() as Promise<{ user: AuthSession['user'] | null }>; })
        .then(({ user }) => { if (!abort.signal.aborted) callback(user ? { user } : null); })
        .catch(() => { if (!abort.signal.aborted) callback(null); });
      return () => abort.abort();
    },
    async signOut() { navigateTop(authPath("signout", "/")); },
    signUp: { async email(_input: { name: string; email: string; password: string }) {
      return { error: { message: "Use Sign in with ChatGPT to request access." } };
    } },
  },
  authUI: {
    mount(container: HTMLElement, options: { redirectTo?: string }) {
      const anchor = document.createElement("a");
      anchor.href = authPath("signin", options.redirectTo || "/drive");
      anchor.target = "_top";
      anchor.textContent = "Sign in with ChatGPT";
      anchor.className = "inline-flex w-full items-center justify-center rounded-lg bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2";
      container.appendChild(anchor);
      return { destroy: () => anchor.remove() };
    },
  },
};
