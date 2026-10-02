/** Optional private Sites service access. Never persist or forward this credential. */
export async function siteFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const configured = process.env.ADRIVE_SITES_URL;
  const credential = process.env.ADRIVE_SITES_AUTHORIZATION;
  const url = new URL(input);
  if (!configured || !credential || url.origin !== new URL(configured).origin) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set("OAI-Sites-Authorization", `Bearer ${credential}`);
  // A redirect must not carry the platform credential to another origin.
  const response = await fetch(input, { ...init, headers, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Private Sites request redirected. Check ADRIVE_SITES_URL and platform access.");
  }
  return response;
}
