import { Hono } from "hono";

import { withErrorHandling } from "../lib/errors";
import { APP_VERSION } from "../lib/version";
import { SHARE_DOWNLOAD_URL_TTL_SECS } from "../types";

export const guideRoutes = new Hono();

guideRoutes.get(
  "/guide",
  withErrorHandling(async (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      name: "Agent Drive",
      version: APP_VERSION,
      description: "Agent-native private cloud drive. Agents upload files, create share links, persist cross-session memories, and other agents download via API — no browser needed.",
      agentSurfaces: {
        description: "All machine-facing entry points of this deployment (owner auth required except shares)",
        mcp: `${origin}/api/public/mcp — remote MCP server. Tools: list_files, read_file, write_file, search_files, create_share, remember, recall, list_memories, forget, send_file. Auth: OAuth 2.1 (discovery at ${origin}/api/public/.well-known/oauth-protected-resource) or owner AGENT_TOKEN bearer.`,
        restApi: `${origin}/api/public/v1/* — files, folders, shares, memory, bundles, webhooks, activity. Same bearer auth and scopes as MCP.`,
        memory: `Persistent agent memory with full-text search. MCP remember/recall, or REST: POST ${origin}/api/public/v1/memory, GET ${origin}/api/public/v1/memory/search?q=..., GET ${origin}/api/public/v1/memory/index-status, POST ${origin}/api/public/v1/memory/rebuild-index. Scopes: read:memory / write:memory.`,
        spaces: `Share your own files/folders/memory with other users by reference (no storage copy). MCP: list_spaces, read_space, add_to_space, remove_from_space, create_space, manage_space_members. REST: ${origin}/api/public/v1/spaces (+ /:id/members, /:id/items). No new scope -- reuses read:drive / write:drive. See the top-level "spaces" field for the full model.`,
        agentCard: `${origin}/api/public/.well-known/agent.json — A2A-compatible Agent Card (identity public key, capabilities, endpoints)`,
        inbox: `${origin}/api/public/inbox — signed Drive-to-Drive file delivery for contacts added by the owner; MCP tool send_file on the sending side`,
        publicBundles: `${origin}/api/public/b/{publicId}/current — anonymously subscribable published bundles, Ed25519-signed manifest (CLI: adrive subscribe <url> --to <dir>)`,
        skill: `${origin}/api/public/skill/manifest — versioned manifest of the installable agent skill (per-file sha256); ${origin}/api/public/skill/file?path=SKILL.md fetches a file. Public, honest 404 on a miss. Use these /api/* paths, not bare /skill/* (see note).`,
        llmsTxt: `${origin}/llms.txt — plain-text index of everything above`,
        note: `Only /api/* paths return honest status. Any other path (e.g. bare /skill/manifest.json, /.well-known/agent.json) falls through the SPA static layer and returns 200 + index.html even when nothing exists — a platform limitation. Machines must probe the /api/public/* canonicals above, where 200 means it exists and 404 means it does not.`,
      },
      accountAccess: {
        description: "Session (browser) callers are gated by their app-level access status; bearer/agent tokens are already owner-scoped credentials and are never gated.",
        status: `GET ${origin}/api/public/v1/account/status — session auth only. Returns { status: "active"|"pending"|"suspended", email, isAdmin }.`,
        apply: `POST ${origin}/api/public/v1/account/apply { message?, ref? } — session auth only. Attaches an optional waitlist message/referral to the caller's pending row. NEVER grants access by itself — only admin approval does.`,
        gate: "A session request to any /api/public/v1/* route other than /account/* and /admin/* is rejected unless status is \"active\": pending -> 403 access_pending, suspended -> 403 access_suspended. The two exempt prefixes let a pending/suspended session always check its status and apply to the waitlist.",
        onboarding: "A new signup starts pending (or active immediately if its email is on the owner's allowlist) and needs the owner to approve it before other endpoints become reachable for that session.",
      },
      registration: {
        description: "Public, unauthenticated hand-off so an agent can help a human who has no account yet get signed up. SECURITY BOUNDARY: the agent only ever supplies email/name/ref and passes a link -- it NEVER handles the password, the browser session, or email verification. Those are the human's, in their own browser.",
        start: `POST ${origin}/api/public/register/start { email, name?, ref? } — no auth, rate-limited by IP (10/hour, else 429 too_many_attempts). Mints a 24h single-use registration intent and returns { handoffUrl: "/signup?token=...", expiresAt }. A "password" field in the body is silently ignored -- there is no way to smuggle one through this endpoint.`,
        intent: `GET ${origin}/api/public/register/intent/{token} — no auth, read-only, never consumes the intent. Returns { email, name, ref }; 404 intent_not_found if the token is unknown, expired, or already consumed by a completed sign-up. This is what the /signup page calls to pre-fill the form.`,
        handoff: "Give the handoffUrl to the human to open in their browser. They set their own password on /signup (goes straight to Better Auth's signUp.email, never through this API) and click the verification link emailed to them. Neither the password nor the verification state is ever visible to the agent.",
        referral: "ref is an optional free-text label (max 128 chars) copied once into the new account's user_access.referredBy for the owner's waitlist review. It NEVER grants access and is never checked against anything -- the allowlist decision is by email match alone.",
        afterVerification: "Once verified, the accountAccess model above takes over: an allowlisted email activates immediately, otherwise the account is pending on the waitlist awaiting owner approval.",
      },
      spaces: {
        description: "Shared Spaces let you share your OWN files, folders, and memory with other users BY REFERENCE -- no storage duplication; the bytes stay owned by whoever contributed them. P1 spaces are invite-only (visibility: 'invite'); there is no public/instance-wide space yet. No new scope was added -- every space endpoint reuses read:drive (list/get/read) / write:drive (create/delete/invite/contribute).",
        identity: "Every space call requires a real resolvable user identity -- a browser session or a user-bound bearer token (OAuth token, minted drive token, or an OWNER_EMAIL-bound AGENT_TOKEN). The legacy deployment-wide AGENT_TOKEN on an OWNER_EMAIL-unset install has no user id to attribute a space to and is rejected with 403 identity_required.",
        roles: "viewer (read all items) < contributor (+ add/remove your OWN items) < editor (+ add/remove ANY item in the space) < creator (+ invite/remove/re-role members, delete the space). Contributing an item is always owner-explicit: add_to_space / POST /spaces/:id/items verifies you own the resource, so you can never expose someone else's file or memory into a space (403 not_your_resource otherwise).",
        liveEditWarning: "SURFACE THIS LOUDLY: space items are live references, not copies. An editor who overwrites a file someone else contributed is editing that person's REAL file, in their own drive -- there is no fork or shadow copy. Only grant editor to someone trusted to co-edit your actual files; viewer/contributor can never write through a space regardless of role table contents.",
        readWiden: "Once you're a member of a space, your normal reads widen to include what's shared there: list_files / read_file / search_files / file download presign and recall / list_memories / memory get all return your own rows UNION items reachable through your active space memberships. A non-member sees exactly what strict owner isolation would show -- nothing extra.",
        memberRemoval: "Removing a member from a space also retracts every item THEY contributed to it (their resources are never deleted -- just no longer reachable through that space once they're gone).",
        mcp: `list_spaces {} / read_space { space, type? } / add_to_space { space, type, path?, memory_key? } / remove_from_space { space, item_id } / create_space { name } / manage_space_members { space, email, role?, remove? }.`,
        restApi: `${origin}/api/public/v1/spaces (create/list), /:id (get/delete), /:id/members (list/invite), /:id/members/:userId (remove/re-role, creator only), /:id/items (contribute/list), /:id/items/:itemId (remove).`,
        errorCodes: "403 identity_required (no user identity), 403 space_forbidden (role too low), 403 not_your_resource (contributing something you don't own), 404 space_not_found (unknown space or non-member -- same code either way, no existence leak), 404 member_not_found, 404 item_not_found.",
        note: "/api/public/v1/admin/* has no space-related surface and stays entirely out of this documentation, same as every other agent-facing surface.",
      },
      quickStart: {
        step1: `GET ${origin}/api/public/s/{shareId} → Get share info (type, hasPassword, fileCount, expired). Password-protected shares withhold name/size/fileCount until you present a valid accessToken`,
        step2: `POST ${origin}/api/public/s/{shareId}/access with body {"password":"xxx"} (or {} if no password) → Get accessToken (15 min TTL)`,
        step3: "Use accessToken in X-Access-Token header for all subsequent requests",
      },
      downloadSingleFile: {
        description: "For file shares or downloading a specific file from a folder share",
        endpoint: `GET ${origin}/api/public/s/{shareId}/download`,
        queryParams: "?fileId={id} (required for folder shares, get IDs from /files)",
        headers: "X-Access-Token: {accessToken}",
        returns: `{ downloadUrl, filename, size, expiresAt, expiresInSecs } — downloadUrl is a presigned URL valid for ${SHARE_DOWNLOAD_URL_TTL_SECS} seconds (expiresInSecs), so start the download promptly. Past that it returns 403 with an XML body <Code>ExpiredRequest</Code>; re-request this endpoint for a fresh URL rather than treating it as a block`,
      },
      downloadFolderAsZip: {
        description: "Download entire folder share (or a subfolder) as a ZIP archive — direct binary response, capped at 400 files and 30MB",
        endpoint: `GET ${origin}/api/public/s/{shareId}/download-zip`,
        queryParams: "?path={subfolder} (optional, to download only a subfolder)",
        headers: "X-Access-Token: {accessToken}",
        returns: "Binary ZIP file (Content-Type: application/zip), or 413 with zip_too_large / zip_file_count_exceeded and a fallback hint",
      },
      browseFiles: {
        description: "List a paginated page of files and folders in a folder share with directory structure",
        endpoint: `GET ${origin}/api/public/s/{shareId}/files`,
        queryParams: "?limit={1-500, default 200}&offset={0+}",
        headers: "X-Access-Token: {accessToken}",
        returns: "{ files: [{ id, name, path, isFolder, size, contentType }], limit, offset } — path is relative to share root",
      },
      errorCodes: {
        "404 share_not_found": "Share link does not exist or was deleted",
        "410 share_expired": "Share link has expired (past expiresAt)",
        "429 share_exhausted": "Download limit reached (downloadCount >= maxDownloads)",
        "403 wrong_password": "Incorrect password",
        "401 invalid_access_token": "Access token is invalid or expired (15 min TTL — request a new one)",
      },
      exampleAgentFlow: [
        `# 1. Check share info`,
        `curl ${origin}/api/public/s/abc12345`,
        ``,
        `# 2. Get access token (with password)`,
        `curl -X POST ${origin}/api/public/s/abc12345/access -H "Content-Type: application/json" -d '{"password":"secret"}'`,
        ``,
        `# 3a. Download entire folder as ZIP (easiest for agents)`,
        `curl -o files.zip ${origin}/api/public/s/abc12345/download-zip -H "X-Access-Token: {token}"`,
        ``,
        `# 3b. Or browse and download individual files`,
        `curl "${origin}/api/public/s/abc12345/files?limit=200&offset=0" -H "X-Access-Token: {token}"`,
        `curl "${origin}/api/public/s/abc12345/download?fileId={id}" -H "X-Access-Token: {token}"`,
        `curl -o file.txt "{downloadUrl from above}"`,
      ],
    });
  })
);
