import { randomUUID } from "node:crypto";

import { readConfig, writeConfig, type AgentDriveConfig, type TokenType } from "../lib/config.js";
import { initializeMcp, normalizeBaseUrl } from "../lib/mcp-client.js";
import { openBrowser } from "../lib/browser.js";
import { DEFAULT_OAUTH_SCOPE, exchangeAuthorizationCode, generatePkcePair, generateState, registerOAuthClient, startCallbackListener, timingSafeEqualString } from "../lib/oauth.js";

interface LoginOptions {
  url: string;
  token?: string;
  tokenType: string;
  noBrowser?: boolean;
  scope?: string;
}

function parseTokenType(value: string): TokenType {
  if (value === "agent_token" || value === "oauth_access_token") return value;
  throw new Error("Invalid --token-type. Expected agent_token or oauth_access_token.");
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const url = normalizeBaseUrl(options.url);
  if (options.token !== undefined) {
    await loginWithToken(url, options);
    return;
  }
  await loginWithOAuth(url, options);
}

async function loginWithToken(url: string, options: LoginOptions): Promise<void> {
  const token = options.token?.trim() ?? "";
  if (!token) throw new Error("--token must not be empty");
  const tokenType = parseTokenType(options.tokenType);
  await initializeMcp({ url, token });

  const existing = await readConfig();
  const now = new Date().toISOString();
  const config: AgentDriveConfig = {
    version: 1,
    url,
    token,
    tokenType,
    machineId: existing?.machineId ?? randomUUID(),
    createdAt: existing?.createdAt ?? now,
  };

  await writeConfig(config);
  console.log(`Logged in to ${url} as machine ${config.machineId}`);
}

async function loginWithOAuth(url: string, options: LoginOptions): Promise<void> {
  const scope = (options.scope ?? DEFAULT_OAUTH_SCOPE).trim();
  if (!scope) throw new Error("--scope must not be empty");
  const existing = await readConfig();
  const listener = await startCallbackListener();
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    void listener.close().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSigint);

  try {
    const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
    const pkce = generatePkcePair();
    const state = generateState();
    const client = await registerOAuthClient(url, redirectUri, scope);
    const authorizeUrl = new URL(`${url}/api/public/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", scope);

    if (options.noBrowser) {
      console.log("Open this URL to authorize Agent Drive:");
      console.log(authorizeUrl.toString());
    } else {
      console.log("Opening browser to authorize Agent Drive...");
      console.log(`If it did not open, visit: ${authorizeUrl.toString()}`);
      await openBrowser(authorizeUrl.toString()).catch(() => {
        console.log("Could not open a browser automatically. Use the URL above.");
      });
    }
    console.log("Waiting for authorization... [press Ctrl-C to cancel]");

    const callbackUrl = await listener.waitFor();
    const returnedState = callbackUrl.searchParams.get("state") ?? "";
    if (!timingSafeEqualString(returnedState, state)) {
      throw new Error("state mismatch — possible CSRF attempt");
    }
    const code = callbackUrl.searchParams.get("code");
    const oauthError = callbackUrl.searchParams.get("error");
    if (oauthError) throw new Error(`OAuth authorization failed: ${oauthError}`);
    if (!code) throw new Error("OAuth authorization failed: missing code");

    const token = await exchangeAuthorizationCode({
      baseUrl: url,
      clientId: client.client_id,
      code,
      redirectUri,
      verifier: pkce.verifier,
    });
    const config: AgentDriveConfig = {
      version: 1,
      url,
      token: token.access_token,
      tokenType: "oauth_access_token",
      clientId: client.client_id,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      scope: token.scope ?? scope,
      machineId: existing?.machineId ?? randomUUID(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await writeConfig(config);
    console.log(`✓ Authorized. Logged in to ${url} as machine ${config.machineId}`);
  } finally {
    process.off("SIGINT", onSigint);
    if (!interrupted) await listener.close();
  }
}
