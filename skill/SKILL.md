---
name: agent-drive
description: Agent-native private cloud drive. Upload, manage, and share files via API. Other agents download via share links — no browser needed. Includes one-click deployment setup.
---

# Agent Drive

Your private cloud drive that agents operate via API. Upload files, organize folders, create password-protected share links, and let other agents download directly.

---

## Part 1: Setup & Deployment

> Skip this if Agent Drive is already deployed. Check: does the file `{project_root}/.env` exist with `AGENT_TOKEN=...`? If yes, go to Part 2.

### 1.1 Check Prerequisites

Run these checks. If anything fails, fix it before proceeding.

```bash
node --version    # Need 18+
git --version     # Need git
edgespark --version  # Need EdgeSpark CLI
```

**EdgeSpark CLI not found?**
```bash
npm install -g edgespark
```

**Not logged in?**
```bash
edgespark login
```
This prints a URL. **STOP and tell the user:**
> Please open this URL in your browser to log in to EdgeSpark: {url}
> If you don't have an EdgeSpark account, sign up free at https://edgespark.dev
> Tell me when you're done.

**Wait for user confirmation before continuing.**

### 1.2 Clone & Initialize

```bash
git clone https://github.com/Yrzhe/agent-drive.git my-agent-drive
cd my-agent-drive
edgespark init my-agent-drive
```

If `edgespark init` fails (directory exists), check `edgespark.toml` for a `project_id`. If present, continue.

### 1.3 Install Dependencies

```bash
cd server && npm install && cd ../web && npm install && cd ..
```

### 1.4 Database & Storage

Run these commands **sequentially** (never in parallel):

```bash
edgespark db generate
edgespark db migrate
edgespark storage apply
```

### 1.5 Configure Auth

```bash
edgespark auth
```

### 1.6 Generate AGENT_TOKEN

```bash
node -e "const t=require('crypto').randomBytes(32).toString('base64url'); require('fs').writeFileSync('.env','AGENT_TOKEN='+t+'\n'); console.log('Token saved to .env')"
edgespark secret set AGENT_TOKEN
```

The second command prints a secure URL. **STOP and tell the user:**
> Please open this URL: {url}
> Then run `cat .env` to see your token, and paste that value into the browser form.
> Click Save, then tell me when done.

**Wait for user confirmation.**

### 1.7 Deploy

```bash
edgespark deploy
```

Save the deployed URL from the output (e.g., `https://xxx.edgespark.app`).

### 1.8 Create Owner Account

**Ask the user:**
> What email and password do you want for your Agent Drive dashboard?

Then create the account:
```bash
curl -X POST https://{URL}/api/_es/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"{email}","password":"{password}","name":"Owner"}'
```

### 1.9 Save Configuration

After deployment, write a local config file so the agent always knows where the drive is:

Create `{project_root}/drive.json`:
```json
{
  "url": "https://{DEPLOYED_URL}",
  "apiBase": "https://{DEPLOYED_URL}/api/public/v1",
  "guideUrl": "https://{DEPLOYED_URL}/api/public/guide",
  "envFile": "{project_root}/.env"
}
```

### 1.10 Show Deployment Summary

```
Agent Drive is live!

  Dashboard:  https://{URL}
  API Base:   https://{URL}/api/public/v1
  Guide URL:  https://{URL}/api/public/guide
  Token:      stored in .env (never share this)
  Login:      {email}

You can now upload files, create folders, and share links.
```

---

## Part 2: Configuration

### Where things are stored

| Item | Location | How to read |
|------|----------|-------------|
| API base URL | `drive.json` → `apiBase` | Read the file |
| AGENT_TOKEN | `.env` → `AGENT_TOKEN=xxx` | `grep AGENT_TOKEN .env \| cut -d= -f2-` |
| Guide URL | `drive.json` → `guideUrl` | Read the file |

### Auth header

All management API calls require:
```
Authorization: Bearer {AGENT_TOKEN}
```

Read the token from `.env`:
```bash
TOKEN=$(grep AGENT_TOKEN .env | cut -d= -f2-)
```

---

## Part 3: File Management

### 3.1 Upload a File

Three-step process: request upload URL → PUT file to R2 → confirm.

```bash
# Step 1: Request presigned upload URL
curl -X POST {apiBase}/files/upload \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "report.pdf",
    "contentType": "application/pdf",
    "size": 12345,
    "path": "/documents"
  }'
# Returns: { fileId, uploadUrl, requiredHeaders, expiresAt }

# Step 2: Upload the file directly to storage
curl -X PUT "{uploadUrl}" \
  -H "Content-Type: application/pdf" \
  --data-binary @report.pdf

# Step 3: Confirm upload (MUST include filename and path)
curl -X POST {apiBase}/files/upload/complete \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"fileId": "{fileId}", "filename": "report.pdf", "path": "/documents"}'
# Returns: { file: { id, name, path, size, ... } }
```

**Notes:**
- `path` is the parent folder path. Use `"/"` for root.
- Parent folders are created automatically if they don't exist.
- `filename` and `path` must be passed to both upload and complete.

### 3.2 Create a Folder

```bash
curl -X POST {apiBase}/folders \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name": "projects", "path": "/"}'
# "path" is the PARENT path — this creates /projects
```

Nested folders:
```bash
# Create /projects/2024/reports
curl -X POST {apiBase}/folders -H "..." -d '{"name": "2024", "path": "/projects"}'
curl -X POST {apiBase}/folders -H "..." -d '{"name": "reports", "path": "/projects/2024"}'
```

### 3.3 List Files

```bash
# List root
curl {apiBase}/files?path=/ -H "Authorization: Bearer {TOKEN}"

# List a subfolder
curl {apiBase}/files?path=/projects/2024 -H "Authorization: Bearer {TOKEN}"

# List everything recursively (flat list)
curl "{apiBase}/files?path=/&recursive=true" -H "Authorization: Bearer {TOKEN}"
```

Returns: `{ files: [{ id, name, path, parentPath, isFolder, size, contentType, createdAt }], path }`

### 3.4 Rename a File or Folder

```bash
curl -X PATCH {apiBase}/files/{fileId} \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-name.pdf"}'
```

### 3.5 Move a File or Folder

```bash
curl -X PATCH {apiBase}/files/{fileId} \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"parentPath": "/new-location"}'
```

You can rename and move in one call:
```bash
-d '{"name": "renamed.pdf", "parentPath": "/archive/2024"}'
```

### 3.6 Delete a File or Folder

```bash
curl -X DELETE {apiBase}/files/{fileId} \
  -H "Authorization: Bearer {TOKEN}"
# Returns: { deleted: N } (number of files deleted)
```

**Deleting a folder deletes everything inside it**, including sub-folders and all files. Associated share links are automatically cleaned up.

### 3.7 Download Your Own File

```bash
# Get file details (includes s3Uri but not a download URL)
curl {apiBase}/files/{fileId} -H "Authorization: Bearer {TOKEN}"
```

To download, create a share link to yourself (no password, 1 download):
```bash
curl -X POST {apiBase}/shares \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"fileId": "{fileId}", "maxDownloads": 1}'
```

Then use the public download flow (Part 5).

### 3.8 Storage Stats

```bash
curl {apiBase}/stats -H "Authorization: Bearer {TOKEN}"
# Returns: { totalFiles, totalFolders, totalSize, totalShares, totalDownloads }
```

---

## Part 4: Share Management

### 4.1 Create a Share Link

**Share a single file:**
```bash
curl -X POST {apiBase}/shares \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "fileId": "{fileId}"
  }'
```

**Share a folder:**
```bash
curl -X POST {apiBase}/shares \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "folderPath": "/projects/demo"
  }'
```

**With all options:**
```bash
curl -X POST {apiBase}/shares \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "fileId": "{fileId}",
    "password": "s3cret",
    "maxDownloads": 10,
    "expiresIn": 86400
  }'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fileId` | string | one of fileId/folderPath | File to share |
| `folderPath` | string | one of fileId/folderPath | Folder path to share |
| `password` | string | no | Password protection. Omit for no password. |
| `maxDownloads` | number | no | Max download count. Omit for unlimited. |
| `expiresIn` | number | no | Seconds until expiry. Omit for never expires. |

**Common expiresIn values:**
- 1 hour = `3600`
- 24 hours = `86400`
- 7 days = `604800`
- 30 days = `2592000`

Returns:
```json
{
  "share": { "id": "abc12345", "shareUrl": "https://{URL}/s/abc12345", ... },
  "shareUrl": "https://{URL}/s/abc12345",
  "guideUrl": "https://{URL}/api/public/guide"
}
```

### 4.2 List Active Shares

```bash
curl {apiBase}/shares -H "Authorization: Bearer {TOKEN}"
```

Returns only **active** shares. Expired or download-exhausted shares are automatically hidden.

### 4.3 Delete (Cancel) a Share

```bash
curl -X DELETE {apiBase}/shares/{shareId} \
  -H "Authorization: Bearer {TOKEN}"
```

Once deleted, the share link immediately stops working. Anyone trying to access it gets `404 share_not_found`.

### 4.4 Modifying Share Settings

Shares are **immutable** after creation. To change password, expiration, or download limit:
1. Delete the old share: `DELETE /shares/{shareId}`
2. Create a new share with updated settings: `POST /shares`

---

## Part 5: Sharing with Other Agents

### 5.1 Handoff Message Format

After uploading and sharing, **always return this message to the user** so they can forward it to the receiving agent:

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

**Example:**
```
Please download the shared content from my Agent Drive:

  📖 Guide: https://my-drive.edgespark.app/api/public/guide
  🔗 Share: https://my-drive.edgespark.app/s/xK9mPq2n
  🔑 Password: demo2024
  ⏰ Expires: 2026-04-11T10:00:00Z
  📥 Max downloads: 10

The receiving agent should read the Guide URL first to learn the download API,
then use the Share URL to access the files.
```

### 5.2 Receiving Agent Download Flow (Pure API)

When another agent receives a share link, they follow this flow. **No browser needed.**

```bash
# 1. Read the guide (learn how the API works)
curl https://{URL}/api/public/guide

# 2. Check share info
curl https://{URL}/api/public/s/{shareId}
# → { type, name, hasPassword, fileCount, expired, exhausted }

# 3. Get access token
curl -X POST https://{URL}/api/public/s/{shareId}/access \
  -H "Content-Type: application/json" \
  -d '{"password": "demo2024"}'
# → { accessToken, expiresAt }
# If no password: -d '{}'

# 4a. Download entire folder as ZIP (recommended for agents)
curl -o files.zip https://{URL}/api/public/s/{shareId}/download-zip \
  -H "X-Access-Token: {accessToken}"

# 4b. Or download a subfolder as ZIP
curl -o scripts.zip "https://{URL}/api/public/s/{shareId}/download-zip?path=scripts" \
  -H "X-Access-Token: {accessToken}"

# 4c. Or browse and download individual files
curl https://{URL}/api/public/s/{shareId}/files \
  -H "X-Access-Token: {accessToken}"
# → { files: [{ id, name, path, isFolder, size }] }

curl "https://{URL}/api/public/s/{shareId}/download?fileId={id}" \
  -H "X-Access-Token: {accessToken}"
# → { downloadUrl, filename, size }

curl -o {filename} "{downloadUrl}"
```

**Access token expires in 15 minutes.** If it expires, request a new one from `/access`.

### 5.3 Share Status & Error Handling

| HTTP Code | Error Code | Meaning |
|-----------|------------|---------|
| 404 | `share_not_found` | Share doesn't exist or was deleted |
| 410 | `share_expired` | Past expiration time |
| 429 | `share_exhausted` | Download limit reached |
| 403 | `wrong_password` | Incorrect password |
| 401 | `invalid_access_token` | Token expired or invalid — get a new one |

When a share expires or hits the download limit:
- The public endpoints return the appropriate error
- The share disappears from the owner's active share list
- The share data remains in the database (the ID cannot be reused)

---

## Part 6: Cloud Drive Organization

### 6.1 Recommended Folder Structure

```
/
├── documents/          ← Reports, PDFs, papers
├── projects/
│   ├── project-a/      ← Per-project folders
│   └── project-b/
├── skills/             ← Skill files and plugins
│   └── my-skill/
├── exports/            ← Generated content for sharing
└── archive/            ← Old files you want to keep
```

### 6.2 Common Operations

**Organize files into a project:**
```bash
# Create project folder
POST /folders → {"name": "project-x", "path": "/projects"}

# Upload files into it
POST /files/upload → {"filename": "spec.md", ..., "path": "/projects/project-x"}

# Move an existing file into the project
PATCH /files/{id} → {"parentPath": "/projects/project-x"}
```

**Archive old files:**
```bash
# Move to archive
PATCH /files/{id} → {"parentPath": "/archive"}
```

**Clean up:**
```bash
# Delete a folder and everything in it
DELETE /files/{folderId}

# Delete a single file
DELETE /files/{fileId}
```

**Share a project folder with someone:**
```bash
POST /shares → {
  "folderPath": "/projects/project-x",
  "password": "collab2024",
  "expiresIn": 604800
}
```

---

## Quick Reference

### Environment
- **API Base**: Read from `drive.json` → `apiBase`
- **Token**: Read from `.env` → `AGENT_TOKEN=...`
- **Auth Header**: `Authorization: Bearer {token}`

### Upload
```
POST /files/upload         → { fileId, uploadUrl, requiredHeaders }
PUT  {uploadUrl}           → upload binary
POST /files/upload/complete → { file } (include fileId, filename, path)
```

### Folders
```
POST /folders              → { name, path (parent) }
```

### Files
```
GET    /files?path=/       → list
GET    /files/:id          → details
PATCH  /files/:id          → rename/move { name?, parentPath? }
DELETE /files/:id          → delete
```

### Shares
```
POST   /shares             → create { fileId|folderPath, password?, maxDownloads?, expiresIn? }
GET    /shares             → list active
DELETE /shares/:id         → cancel
```

### Public (no auth)
```
GET  /s/:id                → share info
POST /s/:id/access         → get token { password? }
GET  /s/:id/files          → browse (X-Access-Token header)
GET  /s/:id/download       → single file (?fileId=) (X-Access-Token header)
GET  /s/:id/download-zip   → folder ZIP (?path=) (X-Access-Token header)
GET  /guide                → API docs for receiving agents
```
