# API Reference

## Auth

All management endpoints (`/api/public/v1/*`) require:
```
Authorization: Bearer {AGENT_TOKEN}
```

Public endpoints (`/api/public/s/*` and `/api/public/guide`) require no auth, but download/files endpoints need `X-Access-Token` from the `/access` endpoint.

---

## Management Endpoints

### Files

#### Upload — Request URL
```
POST /api/public/v1/files/upload
Body: { filename: string, contentType: string, size: number, path?: string }
Returns: { fileId, filename, path, uploadUrl, requiredHeaders, expiresAt }
```
- `path`: parent folder, default `"/"`
- Auto-creates parent folders

#### Upload — Confirm
```
POST /api/public/v1/files/upload/complete
Body: { fileId: string, filename: string, path: string }
Returns: { file: FileObject }
```
- ALL three fields required
- Server verifies file exists in R2 before creating DB record

#### List
```
GET /api/public/v1/files?path={path}&recursive={true|false}
Returns: { files: FileObject[], path: string }
```
- `path`: default `"/"`
- `recursive=true`: flat list of all descendants

#### Get Details
```
GET /api/public/v1/files/{id}
Returns: { file: FileObject }
```

#### Rename / Move
```
PATCH /api/public/v1/files/{id}
Body: { name?: string, parentPath?: string }
Returns: { file: FileObject }
```
- At least one field required
- Folder rename cascades to all children

#### Delete
```
DELETE /api/public/v1/files/{id}
Returns: { deleted: number }
```
- Folder delete is recursive (deletes everything inside)
- Associated shares cleaned up via cascade

### Folders

#### Create
```
POST /api/public/v1/folders
Body: { name: string, path?: string }
Returns: { folder: FileObject }
```
- `path`: parent folder, default `"/"`
- Auto-creates parent chain

### Shares

#### Create
```
POST /api/public/v1/shares
Body: {
  fileId?: string,        // share a file — pick one
  folderPath?: string,    // share a folder — pick one
  password?: string,      // omit = no password
  maxDownloads?: number,  // omit = unlimited
  expiresIn?: number      // seconds, omit = never
}
Returns: { share: ShareObject, shareUrl: string, guideUrl: string }
```

#### List Active
```
GET /api/public/v1/shares
Returns: { shares: ShareObject[] }
```
- Excludes expired and download-exhausted shares

#### Get Details
```
GET /api/public/v1/shares/{id}
Returns: { share: ShareObject }
```

#### Delete
```
DELETE /api/public/v1/shares/{id}
Returns: { success: true }
```

### Stats
```
GET /api/public/v1/stats
Returns: { totalFiles, totalFolders, totalSize, totalShares, totalDownloads }
```

---

## Public Endpoints (no auth)

### Guide
```
GET /api/public/guide
Returns: JSON with API documentation for receiving agents
```

### Share Info
```
GET /api/public/s/{shareId}
Returns: {
  id, type: "file"|"folder", name, size, fileCount,
  hasPassword, maxDownloads, downloadCount,
  expiresAt, expired, exhausted, createdAt
}
```

### Access Token
```
POST /api/public/s/{shareId}/access
Body: { password?: string }
Returns: { accessToken, expiresAt }
```
- `password` required if `hasPassword` is true
- Token valid for 15 minutes
- Errors: 403 wrong_password, 410 share_expired, 429 share_exhausted

### List Shared Files
```
GET /api/public/s/{shareId}/files
Header: X-Access-Token: {accessToken}
Returns: { files: [{ id, name, path, isFolder, size, contentType }] }
```
- `path` is relative to share root
- Includes folders for structure visibility

### Download Single File
```
GET /api/public/s/{shareId}/download?fileId={fileId}
Header: X-Access-Token: {accessToken}
Returns: { downloadUrl, filename, size, expiresAt }
```
- `fileId` required for folder shares, optional for file shares
- `downloadUrl` is presigned, valid 1 hour
- Increments download counter

### Download Folder as ZIP
```
GET /api/public/s/{shareId}/download-zip?path={subfolder}
Header: X-Access-Token: {accessToken}
Returns: binary ZIP file (Content-Type: application/zip)
```
- `path` optional — subfolder relative to share root
- Omit `path` to download entire share
- Increments download counter
- Only for folder shares

---

## Object Types

### FileObject
```json
{
  "id": "string",
  "name": "string",
  "path": "string",
  "parentPath": "string",
  "isFolder": false,
  "size": 12345,
  "contentType": "application/pdf",
  "createdAt": "2026-04-10T10:00:00Z",
  "updatedAt": "2026-04-10T10:00:00Z"
}
```

### ShareObject
```json
{
  "id": "xK9mPq2n",
  "fileId": "abc123",
  "folderPath": null,
  "type": "file",
  "targetName": "report.pdf",
  "hasPassword": true,
  "maxDownloads": 10,
  "downloadCount": 3,
  "expiresAt": "2026-04-11T10:00:00Z",
  "createdAt": "2026-04-10T10:00:00Z",
  "shareUrl": "https://xxx.edgespark.app/s/xK9mPq2n"
}
```

---

## Error Codes

| HTTP | Code | Description |
|------|------|-------------|
| 400 | `validation_error` | Bad request (missing fields, invalid values) |
| 401 | `unauthorized` | No auth header or invalid AGENT_TOKEN |
| 401 | `invalid_access_token` | Share access token expired or invalid |
| 403 | `wrong_password` | Share password incorrect |
| 404 | `file_not_found` | File or folder not found |
| 404 | `share_not_found` | Share link not found or deleted |
| 404 | `upload_not_found` | File not in R2 (upload incomplete) |
| 409 | `path_conflict` | Path already exists |
| 410 | `share_expired` | Share link expired |
| 429 | `share_exhausted` | Download limit reached |
| 500 | `internal_error` | Server error |

All errors return:
```json
{
  "error": { "code": "error_code", "message": "Human-readable message" }
}
```
