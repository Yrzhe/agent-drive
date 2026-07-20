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

#### Search
```
GET /api/public/v1/files/search?q={query}&limit=50
Returns: { files: FileObject[], query: string, count: number }
```
- `q`: shorter than 2 characters returns `{ files: [], query, count: 0 }` without querying
- Matches `name` OR `path` by substring (SQL `LIKE`; `%`/`_` in `q` are escaped to match literally)
- `limit`: default `50`, max `200` — no `offset`, not paginated
- Includes folders in results
- Can return other users' files reachable via your Shared Spaces membership (`spaces.md`)

#### Trash
```
GET /api/public/v1/files/trash?limit=100&offset=0
Returns: { files: FileObject[], retentionDays: 30, limit: number, offset: number }
```
- Each row adds `deletedAt` and `retention: { deletedAt, purgesAt, daysLeft }`
- `path`/`parentPath` are the pre-delete paths (tombstone markers stripped for display)
- `limit`: default `100`, max `500`
- Trashed items are hard-purged automatically 30 days after `deletedAt`

#### Get Details
```
GET /api/public/v1/files/{id}
Returns: { file: FileObject }
```

#### Preview
```
GET /api/public/v1/files/{id}/preview
Returns: { id, name, contentType, size, downloadUrl, expiresInSecs }
```
- Presigned GET URL, valid 300 seconds — same short-TTL pattern as share downloads
- Can preview other users' files reachable via your Shared Spaces membership (`spaces.md`) — the presigned URL is signed against the contributor's stored object, not yours
- Errors: 400 `validation_error` (folders can't be previewed), 409 `upload_pending` (upload not finished), 500 `storage_error` (corrupt storage URI)

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

#### Restore
```
POST /api/public/v1/files/{id}/restore
Returns: { restored: number, file: FileObject }
```
- Only trashed items; 404 `file_not_found` if the id isn't currently in trash
- Restores to the original pre-delete path; 409 `path_conflict` if something now occupies that path — rename/move the conflicting item first
- Folder restore is recursive (`restored` counts every row un-tombstoned)

#### Purge
```
DELETE /api/public/v1/files/{id}/purge
Returns: { purged: number, objectsRemoved: number }
```
- Only trashed items; 404 `file_not_found` if the id isn't currently in trash
- Permanently deletes DB rows and R2 objects — cannot be undone

#### Batch Delete
```
DELETE /api/public/v1/files/batch
Body: { ids: string[] }         // max 200
Returns: {
  requested: number, trashedFiles: number, trashedFolders: number,
  trashedIds: string[], failures: [{ id, error, message }]
}
```
- Partial success: a `200` does not mean every id succeeded — check `failures`
- Per-id failure codes: `file_not_found`, `invalid_scope` (path-scoped token), `delete_failed`
- Folder ids trash recursively, same as single delete

#### Batch Move
```
PATCH /api/public/v1/files/batch
Body: { ids: string[], parentPath: string }   // ids max 200
Returns: {
  requested: number, moved: number, movedIds: string[],
  parentPath: string, failures: [{ id, error, message }]
}
```
- Partial success: a `200` does not mean every id succeeded — check `failures`
- Per-id failure codes: `file_not_found`, `invalid_scope`, `validation_error` (folder into itself), `path_conflict`, `move_failed`
- Auto-creates `parentPath` if it doesn't already exist

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

#### Download & Access Stats
```
GET /api/public/v1/shares/{id}/stats
Returns: {
  share: ShareObject,
  totalDownloads: number, totalAccesses: number,
  firstAccessed: string|null, lastAccessed: string|null, lastDownload: string|null,
  fileBreakdown: [{ fileId, filename, downloads }],
  ipStats: [{ ip, count }],            // top 5
  userAgentStats: [{ userAgent, count }]  // top 5
}
```
- Aggregated from the activity log (`share.downloaded` / `share.accessed` events) for this share
- `fileBreakdown` is per-file download counts for folder shares; empty for file shares

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

### Activity

Read-only audit log of drive events (uploads, deletes, moves, share/webhook lifecycle, …).

```
GET /api/public/v1/activity?type=&since=&limit=50
Returns: { activities: [{ id, eventType, targetType, targetId, targetPath, actor, metadata, createdAt }] }
```
- `type`: exact `eventType` match (e.g. `file.trashed`), omit for all types
- `since`: ISO timestamp lower bound; 400 `validation_error` if unparseable
- `limit`: default `50`, max `200` — no `offset`, not paginated
- Path-scoped tokens only see rows whose `targetPath` is in scope; events with no target path (share/webhook admin actions) are hidden entirely from path-scoped tokens

### Memory

Persistent agent memory with FTS5 full-text search. Scopes: `read:memory` / `write:memory`. Full guide: `memory.md`.

```
POST   /api/public/v1/memory            Body { content, key?, tags?, source? }
Returns: 201 { memory, created } — same key updates in place (created: false)

GET    /api/public/v1/memory            ?limit=20&offset=0
GET    /api/public/v1/memory/search     ?q={query}&limit=10   (best match first)
GET    /api/public/v1/memory/index-status                    Returns { memories, indexed, consistent }
POST   /api/public/v1/memory/rebuild-index                   Returns { rebuilt }
GET    /api/public/v1/memory/{idOrKey}
DELETE /api/public/v1/memory/{idOrKey}  Returns { forgotten }
```

MCP tools: `remember`, `recall`, `list_memories`, `forget`.

### Shared Spaces

Share your files/folders/memory with other users by reference (no storage copy).
Scopes reuse `read:drive`/`write:drive` — no new scope. Full guide: `spaces.md`.

```
POST   /api/public/v1/spaces                      Body { name }
Returns: 201 { space }

GET    /api/public/v1/spaces                       Returns: { spaces: [space, ...] }
GET    /api/public/v1/spaces/{id}                   Returns: { space }
DELETE /api/public/v1/spaces/{id}                   (creator only) Returns: { deleted: true, id }

GET    /api/public/v1/spaces/{id}/members           Returns: { members: [...] }
POST   /api/public/v1/spaces/{id}/members           Body { email, role }        (creator only)
DELETE /api/public/v1/spaces/{id}/members/{userId}  (creator only)
PATCH  /api/public/v1/spaces/{id}/members/{userId}  Body { role }               (creator only)

POST   /api/public/v1/spaces/{id}/items             Body { itemType, ref }
GET    /api/public/v1/spaces/{id}/items             ?type=&limit=&offset=
DELETE /api/public/v1/spaces/{id}/items/{itemId}
```

- Roles: `viewer < contributor < editor < creator`. A `contributor`+ may add
  only resources they own; an `editor` may edit/remove ANY item in the space
  — including overwriting a file someone else contributed (items are live
  references, not copies) — **on invite spaces only**.
- Every space endpoint requires a real user identity: `403 identity_required`
  for the legacy install-wide `AGENT_TOKEN` (no `OWNER_EMAIL` set).
- MCP tools: `list_spaces`, `read_space`, `add_to_space`, `remove_from_space`,
  `create_space`, `manage_space_members`.
- **The public commons:** exactly one instance-wide `visibility: "public"`
  space, implicit `contributor` for every active user, no folders
  (`400 folders_not_allowed_in_public`), withdraw-your-own-item-only unless
  you're the creator/an owner-delegated moderator, `editor` there never
  grants a file-write (moderation only), `memberCount: null` ("everyone on
  this drive"), roster is creator-only. Contributing to it publishes to
  every active user immediately — see `spaces.md` before doing this on a
  human's behalf.

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

### Account & Access (session-only)

Callers are gated by access status on every `/api/public/v1/*` route except
`/account/*` and `/admin/*`: `active` passes, `pending` → 403 `access_pending`,
`suspended` → 403 `access_suspended`. This applies to **sessions AND user-bound bearer
tokens** (OAuth / minted drive tokens) — suspending a user breaks their existing tokens
immediately. Only the legacy install-wide `AGENT_TOKEN` on an `OWNER_EMAIL`-unset
deployment is ungated. Do not retry these 403s. Full guide: `access.md`.

```
GET  /api/public/v1/account/status   (session-only)
Returns: { status: "active"|"pending"|"suspended", email, isAdmin }

POST /api/public/v1/account/apply    (session-only)
Body: { message?, ref? }             max 500 / 128 chars
Returns: { status, email, isAdmin }
```

- `/apply` attaches an optional waitlist message/referral to a `pending` row; it never
  grants access — only owner approval does. A no-op when already `active`.
- Both reject bearer callers with `403 session_required`.

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

#### Publish
```
POST /api/public/v1/bundles/publish
Body: { prefix: string, public: boolean }
Returns: { prefix, public, publicId: string|null, subscribeUrl: string|null }
```
- Requires a bundle already committed at `prefix` — 404 `bundle_not_found` if nothing was ever committed there
- `public: true` mints (or reuses) a `publicId` and exposes it at `subscribeUrl` (`/api/public/b/{publicId}/current`, no auth); `public: false` unpublishes
- Bearer callers need `share:create` in addition to write access to `prefix` — publishing makes content world-readable

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

### Webhooks

Fire-and-forget HTTP callbacks for drive events. Every route requires an unrestricted (`path:/`) token — a path-scoped bearer gets 403 `invalid_scope` on all of `/webhooks/*`.

```
POST   /api/public/v1/webhooks           Body { url, eventTypes: string[], secret? }
Returns: 201 { webhook: { ...WebhookObject, secret }, hint }   — secret shown once, save it now

GET    /api/public/v1/webhooks           ?limit=100&offset=0
Returns: { webhooks: WebhookObject[], limit, offset }

DELETE /api/public/v1/webhooks/{id}
Returns: { success: true }

POST   /api/public/v1/webhooks/{id}/test
Returns: { success: true }               — delivers a `webhook.test` event in the background
```
- `url` must pass SSRF validation (no localhost/private ranges) — 400 `validation_error` on failure
- `eventTypes`: non-empty array of strings, deduplicated
- `secret`: auto-generated if omitted; used to sign delivery payloads
- WebhookObject: `{ id, url, eventTypes, enabled, lastTriggeredAt, lastStatus, failureCount, createdAt }` — never includes `secret` after creation

---

## Public Endpoints (no auth)

### Guide
```
GET /api/public/guide
Returns: JSON with API documentation for receiving agents
```

### Registration Hand-off

Agent-native invite flow for a human with no account yet. Full guide, including the
security boundary: `registration.md`.

```
POST /api/public/register/start
Body: { email: string, name?: string, ref?: string }
Returns: 201 { handoffUrl, expiresAt }
No auth. Rate-limited (10/hour/IP -> 429 too_many_attempts).

GET /api/public/register/intent/{token}
Returns: 200 { email, name, ref }   or   404 intent_not_found
No auth. Read-only — never consumes the intent.
```

- The agent NEVER handles a password, session, or email verification — only the
  human, in a browser at `/signup?token=...`, does. A `password` field sent to
  `/start` is silently ignored.
- `ref` is copied once into `user_access.referredBy` on first sign-in for the owner's
  waitlist review — it never grants access.

### Share Info
```
GET /api/public/s/{shareId}
Returns: {
  id, type: "file"|"folder", name, size, fileCount,
  hasPassword, maxDownloads, downloadCount,
  expiresAt, expired, exhausted, createdAt
}
```
- Password-protected shares withhold `name`/`size`/`fileCount` until a valid access token is presented; before then the response is only `{ id, type, hasPassword: true, expired, exhausted, expiresAt, createdAt }`.

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
Returns: { downloadUrl, filename, size, expiresAt, expiresInSecs }
```
- `fileId` required for folder shares, optional for file shares
- `downloadUrl` is presigned, valid for `expiresInSecs` (300 seconds) — start the download promptly. A 403 with XML `<Code>ExpiredRequest</Code>` means it expired; re-request this endpoint for a fresh URL (see `receiving.md` for 403 triage)
- Increments download counter when the URL is **issued**, not when the bytes are fetched

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
| 403 | `invalid_scope` | Bearer token's scope or path prefix doesn't cover the request |
| 404 | `file_not_found` | File or folder not found |
| 404 | `share_not_found` | Share link not found or deleted |
| 404 | `upload_not_found` | File not in R2 (upload incomplete) |
| 404 | `bundle_not_found` | No bundle committed at this prefix |
| 404 | `webhook_not_found` | Webhook id not found |
| 404 | `intent_not_found` | Registration intent token unknown, expired, or already consumed |
| 403 | `identity_required` | Spaces call with no resolvable user identity |
| 403 | `space_forbidden` | Caller's role in the space is below what the operation requires |
| 403 | `not_your_resource` | Tried to contribute a space item you don't own |
| 400 | `folders_not_allowed_in_public` | Tried to contribute a folder to the public commons (files/memory only) |
| 404 | `space_not_found` | Space doesn't exist, or caller isn't a member |
| 404 | `member_not_found` | Target user isn't a member of the space |
| 404 | `item_not_found` | Item id isn't in this space |
| 409 | `path_conflict` | Path already exists |
| 409 | `upload_pending` | File preview requested before upload finished |
| 410 | `share_expired` | Share link expired |
| 412 | `version_conflict` | Bundle's `currentVersionId` moved since you last saw it (see response `currentVersionId`) |
| 413 | `zip_file_count_exceeded` | Folder ZIP has more than 400 files |
| 413 | `zip_too_large` | Folder ZIP exceeds 30MB |
| 429 | `share_exhausted` | Download limit reached |
| 429 | `too_many_attempts` | Too many `/register/start` calls from one IP within an hour |
| 500 | `internal_error` | Server error |
| 500 | `storage_error` | File preview's stored object reference is invalid |

All errors return:
```json
{
  "error": { "code": "error_code", "message": "Human-readable message" }
}
```
