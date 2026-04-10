---
name: agent-drive
description: Deploy your own Agent Drive — an agent-native private cloud drive. Upload files, create share links, let other agents download via API.
---

# Agent Drive — One-Click Deploy Skill

Deploy your own private cloud drive that your agents can use to upload, share, and download files via API.

## What You Get

- **File management API** — Upload, list, rename, delete files and folders
- **Share links** — Password-protected, with download limits and expiration
- **ZIP download** — Agents download entire folders as ZIP via API, no browser needed
- **Web dashboard** — Browse files, manage shares from a browser
- **Agent guide endpoint** — Receiving agents read `/api/public/guide` to learn the API automatically

## Prerequisites

- **EdgeSpark account** — Free at https://edgespark.dev (Cloudflare Workers hosting with built-in DB, storage, and auth)
- **EdgeSpark CLI** — `npm install -g edgespark` (or `npx edgespark`)
- **Node.js 18+**
- **Git**

## Deployment Flow

Follow these steps IN ORDER. Do not skip steps. Do not run EdgeSpark commands in parallel.

### Step 1: Check Prerequisites

```bash
# Check Node.js
node --version  # Must be 18+

# Check git
git --version

# Check EdgeSpark CLI
edgespark --version
```

**If EdgeSpark CLI is not installed:**
```bash
npm install -g edgespark
```

**If not logged in to EdgeSpark:**
```bash
edgespark login
```
This prints a URL. **SHOW THE URL TO THE USER** and tell them to open it in their browser to authenticate. Wait for them to confirm before continuing.

### Step 2: Clone the Template

```bash
git clone https://github.com/Yrzhe/agent-drive.git my-agent-drive
cd my-agent-drive
```

### Step 3: Initialize EdgeSpark Project

The template has `project_id` commented out. We need to create a new EdgeSpark project:

```bash
edgespark init my-agent-drive
```

If `edgespark init` fails because the directory already exists, check `edgespark.toml` — if it already has a `project_id`, skip to Step 4.

**IMPORTANT:** After init, verify `edgespark.toml` has a valid `project_id`:
```bash
cat edgespark.toml
```

### Step 4: Install Dependencies

```bash
cd server && npm install && cd ../web && npm install && cd ..
```

### Step 5: Set Up Database

```bash
edgespark db generate
edgespark db migrate
```

If migration asks about the branch, ensure you're on the default branch (main/master).

### Step 6: Set Up Storage

```bash
edgespark storage apply
```

### Step 7: Configure Auth

```bash
edgespark auth
```

Follow the prompts to enable email/password auth. If auth is already configured, this step is a no-op.

### Step 8: Generate AGENT_TOKEN

Generate a random token and save it locally:

```bash
python3 -c "import secrets; t=secrets.token_urlsafe(32); open('.env','w').write(f'AGENT_TOKEN={t}\n'); print('Token saved to .env')"
```

Or if Python is not available:
```bash
node -e "const c=require('crypto'); const t=c.randomBytes(32).toString('base64url'); require('fs').writeFileSync('.env','AGENT_TOKEN='+t+'\n'); console.log('Token saved to .env')"
```

Now register the secret on the platform:
```bash
edgespark secret set AGENT_TOKEN
```

This prints a secure URL. **SHOW THE URL TO THE USER** with this message:

> Please open this URL in your browser and paste the token value from the `.env` file.
> You can view the token with: `cat .env`
> After pasting, click Save and come back here.

**Wait for the user to confirm** before continuing.

### Step 9: Deploy

```bash
edgespark deploy
```

This builds and deploys everything. Note the URL in the output (e.g., `https://xxx.edgespark.app`).

### Step 10: Create Owner Account

**ASK THE USER** for their preferred email and password for the web dashboard login:

> What email and password would you like for your Agent Drive dashboard login?

Then register the account via the auth API. The deployed URL is from Step 9:

```bash
curl -X POST https://{DEPLOYED_URL}/api/_es/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"{USER_EMAIL}","password":"{USER_PASSWORD}","name":"Owner"}'
```

After creating the owner account, **disable further registrations** so no one else can sign up. Check if EdgeSpark supports this via:
```bash
edgespark auth --help
```

### Step 11: Output Summary

After successful deployment, present this to the user:

```
=== Agent Drive Deployed Successfully! ===

Dashboard: https://{DEPLOYED_URL}
Login: {USER_EMAIL} / (password you chose)

Agent API Base: https://{DEPLOYED_URL}/api/public/v1
Agent Token: (stored in .env — keep this secret!)

Guide for other agents: https://{DEPLOYED_URL}/api/public/guide

--- How to Use ---

Upload a file (your agent):
  curl -X POST {BASE}/files/upload \
    -H "Authorization: Bearer $(cat .env | cut -d= -f2-)" \
    -H "Content-Type: application/json" \
    -d '{"filename":"hello.txt","contentType":"text/plain","size":5,"path":"/"}'

Create a share link:
  curl -X POST {BASE}/shares \
    -H "Authorization: Bearer $(cat .env | cut -d= -f2-)" \
    -H "Content-Type: application/json" \
    -d '{"fileId":"...","password":"optional","maxDownloads":10,"expiresIn":86400}'

Share with another agent — give them:
  1. Guide URL: https://{DEPLOYED_URL}/api/public/guide
  2. Share URL: https://{DEPLOYED_URL}/s/{shareId}
  3. Password (if set)

The receiving agent reads the guide, then downloads via API automatically.
```

## Handoff Message Template

When your agent uploads and shares a file, it should return this to you:

```
File shared successfully.

Guide: {DEPLOYED_URL}/api/public/guide
Share: {DEPLOYED_URL}/s/{shareId}
Password: {password or "none"}
Expires: {expiresAt or "never"}
Max downloads: {maxDownloads or "unlimited"}

Send the guide URL + share info to the receiving agent.
They will read the guide and download via API automatically.
```

## API Reference (for your agent)

All management endpoints require `Authorization: Bearer {AGENT_TOKEN}` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/public/v1/files/upload` | Request presigned upload URL |
| POST | `/api/public/v1/files/upload/complete` | Confirm upload (include `fileId`, `filename`, `path`) |
| GET | `/api/public/v1/files?path=/` | List files in a folder |
| POST | `/api/public/v1/folders` | Create folder (`name`, `path` for parent) |
| PATCH | `/api/public/v1/files/:id` | Rename or move |
| DELETE | `/api/public/v1/files/:id` | Delete file or folder |
| POST | `/api/public/v1/shares` | Create share link |
| GET | `/api/public/v1/shares` | List active shares |
| DELETE | `/api/public/v1/shares/:id` | Delete share |
| GET | `/api/public/v1/stats` | Storage stats |

## Public Download API (no auth needed)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/public/s/:shareId` | Share info |
| POST | `/api/public/s/:shareId/access` | Get access token (with password) |
| GET | `/api/public/s/:shareId/files` | List files in share |
| GET | `/api/public/s/:shareId/download?fileId=x` | Download single file |
| GET | `/api/public/s/:shareId/download-zip` | Download folder as ZIP |
| GET | `/api/public/guide` | API usage guide for agents |

## Troubleshooting

- **"Not authenticated"** — Run `edgespark login`, show URL to user
- **Migration fails** — Must be on default branch (main/master)
- **Deploy fails** — Run `edgespark deploy --dry-run` first to check
- **Secret not working** — Verify with `edgespark secret list`, re-set if needed
- **Can't sign up** — Check auth config: `edgespark auth`
