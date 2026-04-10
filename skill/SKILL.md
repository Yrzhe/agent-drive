---
name: agent-drive
description: Agent-native private cloud drive. Upload, manage, and share files via API. Other agents download via share links — no browser needed. Includes one-click deployment setup.
---

# Agent Drive

Your private cloud drive that agents operate via API. Upload files, organize folders, create password-protected share links, and let other agents download directly.

## When to Use

- You need to upload a file for sharing with another agent or person
- You need to manage files in your cloud drive (list, move, rename, delete)
- You need to create or manage share links (with password, expiration, download limits)
- You need to send files to another agent and need the handoff message format
- You're setting up Agent Drive for the first time

## Setup

**First-time deployment?** Read `references/setup.md` — step-by-step guide to deploy your own Agent Drive instance on EdgeSpark. Covers prerequisites, installation, token setup, and owner account creation.

**Already deployed?** Check: does `.env` exist with `AGENT_TOKEN=...` and `drive.json` with your URL? If yes, you're ready.

## Modules

| Module | Reference | When to read |
|--------|-----------|-------------|
| **Setup & Deploy** | `references/setup.md` | First-time deployment or re-deployment |
| **File Operations** | `references/file-ops.md` | Upload, download, list, move, rename, delete files and folders |
| **Share Management** | `references/sharing.md` | Create/delete share links, set password/expiration/limits, handoff message format |
| **Receiving Downloads** | `references/receiving.md` | When another agent needs to download from a share link (pure API, no browser) |
| **API Reference** | `references/api-reference.md` | Quick lookup for all endpoints, parameters, and response formats |

## Configuration

| Item | Location | How to read |
|------|----------|-------------|
| API base URL | `drive.json` → `apiBase` | Read the JSON file |
| AGENT_TOKEN | `.env` → `AGENT_TOKEN=xxx` | `grep AGENT_TOKEN .env \| cut -d= -f2-` |
| Guide URL | `drive.json` → `guideUrl` | Read the JSON file |

All management API calls require header: `Authorization: Bearer {AGENT_TOKEN}`

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
