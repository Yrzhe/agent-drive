# Share Management

All endpoints require an `Authorization: Bearer {token}` header — your self-hosted `AGENT_TOKEN` or an OAuth / minted scoped bearer.

## Create a Share Link

### Share a single file
```bash
POST {apiBase}/shares
Body: { "fileId": "{fileId}" }
```

### Share a folder
```bash
POST {apiBase}/shares
Body: { "folderPath": "/projects/demo" }
```

Use `{"folderPath": "/"}` to share the whole drive as a virtual root folder. Blank or whitespace-only `folderPath` is invalid; use an explicit `/` for root.

### With all options
```bash
POST {apiBase}/shares
Body: {
  "fileId": "{fileId}",          ← OR "folderPath": "/path"
  "password": "s3cret",          ← optional, omit for no password
  "maxDownloads": 10,            ← optional, omit for unlimited
  "expiresIn": 86400             ← optional seconds, omit for never
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fileId` | string | one of two | Share a single file |
| `folderPath` | string | one of two | Share a folder (all contents) |
| `password` | string | no | Password protection. Omit = no password. |
| `maxDownloads` | integer | no | Download limit. Omit = unlimited. |
| `expiresIn` | integer | no | Seconds until expiry. Omit = never expires. |

### Common expiresIn values
- 1 hour = `3600`
- 24 hours = `86400`
- 7 days = `604800`
- 30 days = `2592000`

### Response
```json
{
  "share": {
    "id": "xK9mPq2n",
    "shareUrl": "https://{URL}/s/xK9mPq2n",
    "type": "file",
    "targetName": "report.pdf",
    "hasPassword": true,
    "maxDownloads": 10,
    "downloadCount": 0,
    "expiresAt": "2026-04-11T10:00:00Z",
    "createdAt": "2026-04-10T10:00:00Z"
  },
  "shareUrl": "https://{URL}/s/xK9mPq2n",
  "guideUrl": "https://{URL}/api/public/guide"
}
```

## List Active Shares

```bash
GET {apiBase}/shares
```

Returns only **active** shares. Expired or download-exhausted shares are automatically hidden from the list (but still exist in DB — the share ID cannot be reused).

## Delete (Cancel) a Share

```bash
DELETE {apiBase}/shares/{shareId}
```

Immediately invalidates the link. Anyone accessing it gets `404 share_not_found`.

## Modify Share Settings

Shares are **immutable** after creation. To change password, expiration, or download limit:

1. Delete the old share: `DELETE /shares/{shareId}`
2. Create a new share with updated settings: `POST /shares`

The new share will have a different ID/URL.

## Share Lifecycle

```
Created → Active → Expired (expiresAt passed)
                 → Exhausted (downloadCount >= maxDownloads)
                 → Deleted (owner cancels)
```

- **Active**: appears in share list, download works
- **Expired/Exhausted**: hidden from your share list. The status endpoint `GET /s/{shareId}` still answers **200** with `{ expired: true }` / `{ exhausted: true }` — it does NOT error. Only the acting endpoints refuse: `/access`, `/download`, and `/download-zip` throw `410 share_expired` / `429 share_exhausted`. **Do not infer liveness from a 200 on the status endpoint — read the two flags.**
- **Deleted**: removed from DB, every endpoint returns 404 `share_not_found`

## Share Analytics

```bash
GET {apiBase}/shares/{shareId}/stats
Returns: {
  share, totalDownloads, totalAccesses,
  firstAccessed, lastAccessed, lastDownload,
  fileBreakdown: [{ fileId, filename, downloads }],
  ipStats:        [{ ip, count }],
  userAgentStats: [{ userAgent, count }]
}
```

Owner-only. Note that `ipStats` and `userAgentStats` are personally identifying information about whoever opened the link — report them to the owner when asked, but do not volunteer or republish them elsewhere.

## Handoff Message Format

After creating a share, **always output this message** so the user can forward it to the receiving agent:

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

**Rules for the handoff message:**
- Always include the Guide URL — it teaches the receiving agent how to use the API
- Always include all five fields, even when password is "none" or expires is "never"
- The first line "Please download..." makes it clear what to do when pasted to another agent
- Do NOT include the AGENT_TOKEN — it's the owner's private key, not for sharing
