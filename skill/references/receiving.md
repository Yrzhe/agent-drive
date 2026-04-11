# Receiving Downloads

How to download files from an Agent Drive share link. Pure API — no browser, no login needed.

## What You Receive

The sending agent provides:
```
📖 Guide: https://some-drive.edgespark.app/api/public/guide
🔗 Share: https://some-drive.edgespark.app/s/xK9mPq2n
🔑 Password: demo2024
⏰ Expires: 2026-04-11T10:00:00Z
📥 Max downloads: 10
```

## Download Flow

### Step 1: Read the Guide (optional but recommended)

```bash
GET {guideUrl}
```

Returns JSON with complete API documentation. Read this to understand available endpoints.

### Step 2: Check Share Info

```bash
GET https://{host}/api/public/s/{shareId}
```

Returns:
```json
{
  "id": "xK9mPq2n",
  "type": "folder",        ← "file" or "folder"
  "name": "my-project",
  "size": 29069,
  "fileCount": 6,
  "hasPassword": true,      ← need password for access?
  "maxDownloads": 10,
  "downloadCount": 3,
  "expiresAt": "2026-04-11T10:00:00Z",
  "expired": false,
  "exhausted": false
}
```

If `expired` or `exhausted` is true, the share is no longer accessible.

### Step 3: Get Access Token

```bash
POST https://{host}/api/public/s/{shareId}/access
Content-Type: application/json
Body: {"password": "demo2024"}
```

If no password is required (`hasPassword: false`):
```bash
Body: {}
```

Returns:
```json
{
  "accessToken": "1775790311674.874db...",
  "expiresAt": "2026-04-10T03:20:11.674Z"
}
```

**Token is valid for 15 minutes.** If expired, request a new one.

All subsequent requests need the header: `X-Access-Token: {accessToken}`

### Step 4: Download

Choose the method that fits your need:

#### Option A: Download entire folder as ZIP (recommended)

```bash
GET https://{host}/api/public/s/{shareId}/download-zip
Header: X-Access-Token: {accessToken}
```

Returns: binary ZIP file directly. Save to disk.

```bash
curl -o files.zip "https://{host}/api/public/s/{shareId}/download-zip" \
  -H "X-Access-Token: {accessToken}"
```

#### Option B: Download a subfolder as ZIP

```bash
GET https://{host}/api/public/s/{shareId}/download-zip?path=scripts
Header: X-Access-Token: {accessToken}
```

`path` is relative to the share root. Example: if the share is `/projects/demo` and it has a `scripts/` subfolder, use `?path=scripts`.

#### Option C: Browse files and download individually

**List files:**
```bash
GET https://{host}/api/public/s/{shareId}/files
Header: X-Access-Token: {accessToken}
```

Returns:
```json
{
  "files": [
    {"id": "abc", "name": "SKILL.md", "path": "SKILL.md", "isFolder": false, "size": 9026},
    {"id": "def", "name": "scripts", "path": "scripts", "isFolder": true, "size": 0},
    {"id": "ghi", "name": "main.py", "path": "scripts/main.py", "isFolder": false, "size": 3057}
  ]
}
```

`path` is relative to the share root. Folders are included for structure visibility.

**Download a specific file:**
```bash
GET https://{host}/api/public/s/{shareId}/download?fileId={id}
Header: X-Access-Token: {accessToken}
```

Returns:
```json
{
  "downloadUrl": "https://...r2.cloudflarestorage.com/...",
  "filename": "main.py",
  "size": 3057,
  "expiresAt": "2026-04-10T04:00:00Z"
}
```

Then fetch the file:
```bash
curl -o main.py "{downloadUrl}"
```

The `downloadUrl` is a presigned R2 URL, valid for **1 hour**.

#### Option D: Download single file share

For shares where `type` is `"file"` (not folder), no `fileId` needed:

```bash
GET https://{host}/api/public/s/{shareId}/download
Header: X-Access-Token: {accessToken}
```

## Handling Large Folders (>50MB)

ZIP download has a 50MB limit. If the folder exceeds it, the server returns 413 with a helpful response:

```json
{
  "error": {
    "code": "zip_too_large",
    "message": "ZIP download is limited to 50MB. This folder is 120MB.",
    "hint": "Use GET /files to list all files, then GET /download?fileId=<id> to download each individually.",
    "filesEndpoint": "/api/public/s/{shareId}/files",
    "fileCount": 42,
    "totalSizeMB": 120
  }
}
```

**When you get a 413, follow this fallback flow:**

1. Call `/files` to get the complete file list with relative paths
2. For each file (where `isFolder` is false):
   - Call `/download?fileId={id}` to get the presigned URL
   - Download the file
   - Save it to the correct relative path to preserve folder structure
3. Access token expires in 15 min — if downloading many files, request a new token midway

```bash
# Fallback: download files individually, preserving structure
FILES=$(curl -s $HOST/api/public/s/$SHARE/files -H "X-Access-Token: $TOKEN")

# For each file, download to the correct relative path
echo "$FILES" | jq -c '.files[] | select(.isFolder == false)' | while read -r file; do
  FILE_ID=$(echo "$file" | jq -r '.id')
  FILE_PATH=$(echo "$file" | jq -r '.path')

  # Get presigned download URL
  DL=$(curl -s "$HOST/api/public/s/$SHARE/download?fileId=$FILE_ID" \
    -H "X-Access-Token: $TOKEN")
  DL_URL=$(echo "$DL" | jq -r '.downloadUrl')

  # Create parent directory and download
  mkdir -p "$(dirname "downloaded/$FILE_PATH")"
  curl -s -o "downloaded/$FILE_PATH" "$DL_URL"
done
```

**Decision flow for agents:**
```
Try /download-zip
  ├─ 200 → done (save ZIP, unzip)
  ├─ 413 → folder too large, switch to individual downloads
  └─ other error → handle normally
```

## Error Handling

| HTTP | Code | Meaning | What to do |
|------|------|---------|------------|
| 404 | `share_not_found` | Share doesn't exist or deleted | Nothing — link is dead |
| 410 | `share_expired` | Past expiration time | Request a new share from the sender |
| 413 | `zip_too_large` | Folder exceeds 50MB ZIP limit | Download files individually (see above) |
| 429 | `share_exhausted` | Download limit reached | Request a new share from the sender |
| 403 | `wrong_password` | Wrong password | Check password and retry |
| 401 | `invalid_access_token` | Token expired (15 min) | Call `/access` again for a new token |

## Complete Example

```bash
HOST="https://some-drive.edgespark.app"
SHARE="xK9mPq2n"

# 1. Check
curl $HOST/api/public/s/$SHARE

# 2. Authenticate
TOKEN=$(curl -s -X POST $HOST/api/public/s/$SHARE/access \
  -H "Content-Type: application/json" \
  -d '{"password":"demo2024"}' | jq -r '.accessToken')

# 3. Try ZIP first, fallback to individual downloads
HTTP_CODE=$(curl -s -o download.zip -w "%{http_code}" \
  $HOST/api/public/s/$SHARE/download-zip \
  -H "X-Access-Token: $TOKEN")

if [ "$HTTP_CODE" = "200" ]; then
  unzip download.zip -d ./downloaded-files/
elif [ "$HTTP_CODE" = "413" ]; then
  echo "Folder too large for ZIP, downloading files individually..."
  # Use the individual download fallback flow above
fi
```
