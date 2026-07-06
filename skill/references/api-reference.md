# API Reference

## Auth

All management endpoints (`/api/public/v1/*`) require browser session auth or:
```
Authorization: Bearer {AGENT_TOKEN}
```

For MCP, `AGENT_TOKEN` defaults to `read:drive write:drive share:create read:memory write:memory path:/` and may be narrowed with `AGENT_TOKEN_SCOPES`.

Public endpoints (`/api/public/s/*` and `/api/public/guide`) require no auth, but download/files endpoints need `X-Access-Token` from the `/access` endpoint.

---

## Discovery

```
GET /api/public/.well-known/agent.json        A2A-compatible Agent Card (public, no auth)
GET /api/public/.well-known/agent-card.json   Same document, newer A2A naming
```

The card carries this deployment's Ed25519 public key (`signing.publicKeyJwk`), capability list, and all machine endpoints under `x-agent-drive`. Give another agent this URL (or just the drive URL — it can find `/llms.txt`) to introduce your Drive.

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
Returns: { files: FileObject[], path: string, limit: number, offset: number }
```
- `path`: default `"/"`
- `recursive=true`: flat list of all descendants
- `limit`: default `100`, max `500`
- `offset`: default `0`

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
Returns: { trashed: number, targetId: string }
```
- Soft-delete to trash; folder delete is recursive (trashes everything inside)
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
- `folderPath: "/"` explicitly creates a virtual whole-drive root share
- blank or whitespace-only `folderPath` is invalid

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
- File/folder counts and size exclude trashed rows
- Requires an unrestricted (`path:/`) token — aggregates span the whole drive

### Memory

Persistent agent memory with FTS5 full-text search. Scopes: `read:memory` / `write:memory`. Full guide: `memory.md`.

```
POST   /api/public/v1/memory            Body { content, key?, tags?, source? }
Returns: 201 { memory, created } — same key updates in place (created: false)

GET    /api/public/v1/memory            ?limit=20&offset=0
GET    /api/public/v1/memory/search     ?q={query}&limit=10   (best match first)
GET    /api/public/v1/memory/{idOrKey}
DELETE /api/public/v1/memory/{idOrKey}  Returns { forgotten }
```

MCP tools: `remember`, `recall`, `list_memories`, `forget`.

### List pagination

All list endpoints (`GET /v1/files/trash`, `/v1/shares`, `/v1/contacts`, `/v1/tokens`, `/v1/webhooks`) accept `?limit=` (default 100, max 500) and `?offset=`, and echo `{ limit, offset }` in the response. Note for path-scoped tokens: trash/share rows outside your prefix are filtered AFTER the SQL page, so a page may come back short — keep paging until an empty page.

### Scoped Drive Tokens (owner/session-only)

Minting and revoking tokens requires browser session auth — bearer tokens are rejected with 403 `session_required` (no privilege escalation). The owner uses the `/connect` page UI; the endpoints behind it:

```
POST   /api/public/v1/tokens      Body { label?, scopes: [...], pathPrefix?, expiresInDays? }
Returns: 201 { token, hint, tokenInfo } — token shown once

GET    /api/public/v1/tokens      List minted tokens (label, scopes, expiry, status)
DELETE /api/public/v1/tokens/:id  Revoke immediately
```

Mintable scopes: `read:drive write:drive share:create read:memory write:memory` (+ optional path prefix). Minted tokens authenticate exactly like OAuth bearers on MCP and REST.

### Contacts & Inbox (Drive-to-Drive)

Contact management is owner/session-only; sending is an agent action. Full guide: `peering.md`.

```
POST   /api/public/v1/contacts              { url, name?, autoRelease? }   (session-only; fetches peer Agent Card)
GET    /api/public/v1/contacts                                             (session-only)
PATCH  /api/public/v1/contacts/:name        { autoRelease }                (session-only)
DELETE /api/public/v1/contacts/:name                                       (session-only)
POST   /api/public/v1/contacts/:name/send   { path, message? }             (bearer OK; max 5MB)

POST   /api/public/inbox                    signed peer delivery (public route, X-Agent-Signature)
```

MCP tool: `send_file { contact, path, message? }` (scope `share:create`). Received files land in `/inbox/pending/<contact>/` quarantine unless the contact has `autoRelease`.

### Bundles

Bundles are versioned manifests used by `adrive sync`. File bytes are uploaded separately; the bundle endpoints manage the version pointer and manifest history.

#### Commit
```
POST /api/public/v1/bundles/commit
Body: { prefix: string, ifMatch?: string|null|"*", manifest: BundleManifest }
Returns: { versionId, previousVersionId, pushedAt, manifestPath, hash, fileCount, totalSize }
```
- `prefix` must be a non-root folder path.
- `ifMatch` protects against stale writes. Use the last seen `versionId`, `null` for a fresh bundle, or `"*"` to force.
- File/artifact writes are not fully atomic with the pointer swap; failed racing commits can leave non-current artifacts behind.

#### Current
```
GET /api/public/v1/bundles/current?prefix={prefix}
Returns: { prefix, currentVersion: BundleVersion|null }
```

#### History
```
GET /api/public/v1/bundles/history?prefix={prefix}&limit=50
Returns: { prefix, currentVersionId, history: BundleVersion[] }
```

#### Manifest
```
GET /api/public/v1/bundles/manifest?prefix={prefix}&versionId={versionId}
Returns: { prefix, versionId, manifest }
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
GET /api/public/s/{shareId}/files?limit=200&offset=0
Header: X-Access-Token: {accessToken}
Returns: { files: [{ id, name, path, isFolder, size, contentType }], limit: number, offset: number }
```
- `path` is relative to share root
- Includes folders for structure visibility
- `limit`: default `200`, max `500`
- `offset`: default `0`

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
- ZIP size limit: 30MB
- ZIP file-count limit: 400 files; larger folders return 413 `zip_file_count_exceeded` with a hint to page `/files` and use `/download?fileId=...`

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
| 401 | `unauthorized` | No auth header |
| 401 | `invalid_token` | Invalid bearer token |
| 401 | `invalid_access_token` | Share access token expired or invalid |
| 403 | `wrong_password` | Share password incorrect |
| 404 | `file_not_found` | File or folder not found |
| 404 | `share_not_found` | Share link not found or deleted |
| 404 | `upload_not_found` | File not in R2 (upload incomplete) |
| 409 | `path_conflict` | Path already exists |
| 410 | `share_expired` | Share link expired |
| 413 | `zip_file_count_exceeded` | Folder ZIP has more than 400 files |
| 413 | `zip_too_large` | Folder ZIP exceeds 30MB |
| 429 | `share_exhausted` | Download limit reached |
| 500 | `internal_error` | Server error |

All errors return:
```json
{
  "error": { "code": "error_code", "message": "Human-readable message" }
}
```
