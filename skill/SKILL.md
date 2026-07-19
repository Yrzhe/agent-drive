---
name: agent-drive
description: Agent-native private cloud drive. Upload, manage, and share files via API. Other agents download via share links — no browser needed. Includes one-click deployment setup.
---

# Agent Drive

Your private cloud drive that agents operate via API. Upload files, organize folders, create password-protected share links (including whole-drive root shares), sync versioned bundles, persist cross-session memories, and let other agents download directly.

## When to Use

- You need to upload a file for sharing with another agent or person
- You need to manage files in your cloud drive (list, move, rename, delete)
- You need to create or manage share links (with password, expiration, download limits)
- You need to sync a local project folder to Agent Drive with version checks
- You need to persist decisions/context across sessions and recall them later (memory)
- You need to share your files/folders/memory with other users by reference (no copy), or read a space you were invited into
- You need to send files to another agent and need the handoff message format
- You're setting up Agent Drive for the first time

## Setup

**First-time deployment?** Read `references/setup.md` — step-by-step guide to deploy your own Agent Drive instance on EdgeSpark. Covers prerequisites, installation, token setup, and owner account creation.

**Already deployed?** Check: does `.env` exist with `AGENT_TOKEN=...` and `drive.json` with your URL? If yes, you're ready.

## Modules

| Module | Reference | When to read |
|--------|-----------|-------------|
| **Setup & Deploy** | `references/setup.md` | First-time deployment or re-deployment |
| **MCP (remote tools)** | `references/mcp.md` | Connect an IDE/agent over Remote MCP; OAuth vs AGENT_TOKEN; the 16 tools + scopes |
| **File Operations** | `references/file-ops.md` | Upload, download, list, move, rename, delete files and folders |
| **Share Management** | `references/sharing.md` | Create/delete share links, set password/expiration/limits, handoff message format |
| **Receiving Downloads** | `references/receiving.md` | When another agent needs to download from a share link (pure API, no browser) |
| **Memory** | `references/memory.md` | Persist decisions/context across sessions (`remember`/`recall` MCP tools, full-text search) |
| **Shared Spaces** | `references/spaces.md` | Share your files/folders/memory with other users by reference (no copy); discover, read, contribute, roles, the live-edit warning |
| **Peering** | `references/peering.md` | Send files Drive-to-Drive (`send_file`), receive via signed inbox, subscribe to published bundles |
| **Account & Access** | `references/access.md` | A session call comes back `403 access_pending` / `403 access_suspended` — check status, apply to the waitlist |
| **Registration Hand-off** | `references/registration.md` | Helping a human who has no account yet sign up — you mint the invite link, they set the password |
| **API Reference** | `references/api-reference.md` | Quick lookup for all endpoints, parameters, and response formats |

### Keeping this skill current

If you hit an endpoint or behavior a reference doesn't document, this installed copy may be
stale. Check against the live deployment and update in place:

```bash
scripts/update.sh --check   # report local vs remote version + changed files; writes nothing
scripts/update.sh           # download + verify (sha256) + swap in the changed files
```

The URL comes from your `drive.json`; files are verified against the deployment's signed
manifest before anything is written, and `drive.json` / `.env` are never touched.

## Configuration

Config files are in this skill's directory, use relative paths:

| Item | File | How to read |
|------|------|-------------|
| API base URL | `drive.json` → `apiBase` | Read `drive.json` in this directory |
| AGENT_TOKEN | `.env` → `AGENT_TOKEN=xxx` | Read `.env` in this directory, extract value after `=` |
| Guide URL | `drive.json` → `guideUrl` | Read `drive.json` in this directory |

**Not configured yet?** After running `references/setup.md`, the setup process creates both files:
- `.env` — contains `AGENT_TOKEN=xxx`
- `drive.json` — contains `{ "url": "...", "apiBase": "...", "guideUrl": "..." }`

All management API calls require header: `Authorization: Bearer {AGENT_TOKEN}` unless you are using browser session auth. This bypass token defaults to drive/share/memory scopes (`read:drive write:drive share:create read:memory write:memory path:/`) and can be narrowed by deployment var `AGENT_TOKEN_SCOPES`; scopes are enforced on both MCP tools and REST endpoints.

To connect an **IDE / third-party MCP client**, the owner opens `{url}/connect` to mint a scoped OAuth token and copy a per-client config snippet — use that instead of the `AGENT_TOKEN` for external clients. See `references/mcp.md`.

## Share Handoff Message (IMPORTANT)

Every time you create a share link, you MUST reply to the user with this exact format so they can copy-paste it to the receiving agent:

```
Please download the shared content from my Agent Drive:

  📖 Guide: {guideUrl}
  🔗 Share: {shareUrl}
  🔑 Password: {password or "none"}
  ⏰ Expires: {expiresAt or "never"}
  📥 Max downloads: {maxDownloads or "unlimited"}

The receiving agent should read the Guide URL first to learn the download API,
then use the Share URL to access the files.
```

**Rules:**
- The first line "Please download..." is critical — it tells the receiving agent what to do when the user pastes this message
- Always include ALL five fields even when values are "none", "never", or "unlimited"
- The Guide URL teaches the receiving agent the full download API — always include it
- NEVER include the AGENT_TOKEN in this message — it is the owner's private key
- See `references/sharing.md` for full details on creating shares with different options
