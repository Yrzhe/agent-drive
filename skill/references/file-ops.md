# File Operations

All endpoints require an `Authorization: Bearer {token}` header — the token can be your self-hosted `AGENT_TOKEN` **or** an OAuth / minted scoped bearer (REST and MCP accept the same tokens). For the owner's own agent, read `AGENT_TOKEN` from `.env` and the API base from `drive.json`.

## Upload a File

Three-step process: request URL → upload binary → confirm.

```bash
# Step 1: Request presigned upload URL
POST {apiBase}/files/upload
Body: {
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "size": 12345,
  "path": "/documents"       ← parent folder path, "/" for root
}
Returns: { fileId, uploadUrl, requiredHeaders, expiresAt }

# Step 2: PUT file to the presigned URL
PUT {uploadUrl}
Header: Content-Type: {contentType}
Body: binary file data

# Step 3: Confirm upload (MUST include filename and path)
POST {apiBase}/files/upload/complete
Body: { "fileId": "{fileId}", "filename": "report.pdf", "path": "/documents" }
Returns: { file: { id, name, path, size, ... } }
```

**Notes:**
- `path` is the parent folder. Use `"/"` for root.
- Parent folders are created automatically.
- `filename` is required. `path` defaults to `"/"` (root) if omitted.
- Always pass `filename` and `path` to both upload and complete for clarity.

**Limits** (both configurable per deployment via the `MAX_FILE_BYTES` / `MAX_TOTAL_BYTES` vars; `0` = unlimited):
- Per-file cap (default **500 MB**) — enforced on the declared size at step 1 and on the real object size at step 3 (an over-limit object is deleted, not kept). Error: `413 file_too_large`.
- Total-storage quota (default **5 GB** of active, non-trashed files) — error: `413 quota_exceeded`.
- An upload you never confirm (step 3 skipped) is auto-reclaimed: a new upload to the same path takes over once the presigned URL has expired, and abandoned tickets are swept after 24 h.

## Create a Folder

```bash
POST {apiBase}/folders
Body: { "name": "projects", "path": "/" }
```

`path` is the PARENT — this creates `/projects`.

**Nested example:**
```bash
POST /folders → {"name": "2024", "path": "/projects"}         → /projects/2024
POST /folders → {"name": "reports", "path": "/projects/2024"}  → /projects/2024/reports
```

## List Files

```bash
# List a folder's contents
GET {apiBase}/files?path=/
GET {apiBase}/files?path=/projects/2024

# List everything recursively (flat)
GET {apiBase}/files?path=/&recursive=true

# Page through a large folder
GET {apiBase}/files?path=/&limit=500&offset=500
```

Returns: `{ files: [{ id, name, path, parentPath, isFolder, size, contentType, createdAt, updatedAt }], path, limit, offset }`

**This endpoint is paginated and truncates silently.** `limit` defaults to **100** and is clamped to 1–500; `offset` defaults to 0. A folder with more than 100 entries returns only the first 100 with no flag saying so — if you need the whole listing, page until you get back fewer rows than you asked for. Do not treat one call as complete.

Sort order differs by mode:
- **Non-recursive** — folders first, then by name (`isFolder DESC, name ASC`).
- **`recursive=true`** — by full path only. Folders and files are interleaved, NOT grouped.

**Reads can return files you do not own.** If you belong to any Shared Space, this endpoint (and `search`, `GET /files/{id}`, and preview/download) returns your own files UNION the items reachable through your space memberships. With no memberships the result is exactly your own files.

The file objects here carry **no ownership field** — you cannot tell from this response whether a row is yours or someone else's. To attribute an item, list the space (`read_space` / `GET /spaces/{id}/items`), whose entries carry `contributedBy`. Until you have done that, do not describe a listed file to a human as "your file", and do not re-share or delete it on the assumption that it is. Writes remain owner-only unless you hold `editor` in a space that carries the file — see `spaces.md`.

## Get File Details

```bash
GET {apiBase}/files/{fileId}
Returns: { file: { id, name, path, ... } }
```

## Rename

```bash
PATCH {apiBase}/files/{fileId}
Body: { "name": "new-name.pdf" }
```

For folders, all child paths are updated automatically.

## Move

```bash
PATCH {apiBase}/files/{fileId}
Body: { "parentPath": "/archive/2024" }
```

Rename + move in one call:
```bash
Body: { "name": "renamed.pdf", "parentPath": "/archive" }
```

## Delete

```bash
DELETE {apiBase}/files/{fileId}
Returns: { trashed: N, targetId: string }
```

Delete is a soft-delete to trash. Deleting a folder trashes everything inside it, and associated share links are cleaned up via cascade. Trashed files are excluded from share downloads and drive stats. Trashed items are moved to an internal tombstone namespace, so re-creating a file or folder at the same path is safe and does not destroy the trashed copy; restoring returns 409 `path_conflict` if the original path is occupied again.

## Search

```bash
GET {apiBase}/files/search?q=invoice&limit=50
Returns: { files: [...], query, count }
```

Substring match on **name and path** (not file contents). `q` shorter than 2 characters returns an empty list rather than an error. `limit` defaults to 50, clamped 1–200; there is no `offset` — narrow the query instead of paging. Sorted folders first, then by name. Like all reads, this can return space-shared files you do not own.

## Trash, Restore, Purge

Nothing is destroyed by `DELETE /files/{id}` — it is recoverable for **30 days**.

```bash
# List trashed items (newest deletion first)
GET {apiBase}/files/trash?limit=100&offset=0
Returns: { files: [{ ..., deletedAt, retention }], retentionDays: 30, limit, offset }

# Put one back at its original path
POST {apiBase}/files/{fileId}/restore

# Destroy it now, bytes included — irreversible
DELETE {apiBase}/files/{fileId}/purge
Returns: { purged: N, objectsRemoved: N }
```

`GET /files/trash` is paginated the same way as the list endpoint (`limit` default 100, max 500). Restoring a folder restores its whole subtree; if something else now occupies the original path you get 409 `path_conflict` — move the occupant first. Purge deletes the DB rows and the underlying objects with no recovery path, so prefer letting the 30-day retention expire unless the user explicitly asked to destroy something.

## Batch Operations

Up to **200 ids** per call.

```bash
# Trash many at once
DELETE {apiBase}/files/batch
Body: { "ids": ["id1", "id2"] }
Returns: { requested, trashedFiles, trashedFolders, trashedIds, failures: [{ id, error, message }] }

# Move many into one folder
PATCH {apiBase}/files/batch
Body: { "ids": ["id1", "id2"], "parentPath": "/archive/2024" }
```

**Both are partial-success — a 200 does NOT mean every id succeeded.** Compare `requested` against what actually moved, and read `failures[]`. An id you do not own simply does not appear in the results; it is not an error. `parentPath` is required on the move, and its folder chain is created if missing. Batch operations act only on files you own — they are never widened by space membership.

## Download Your Own File

As the authenticated owner you can fetch a file directly — no share needed:

```bash
# REST: get a short-lived (300s) presigned download URL, then GET it
GET {apiBase}/files/{fileId}/preview
Returns: { id, name, contentType, size, downloadUrl, expiresInSecs }

# MCP: read_file returns UTF-8 text content directly (text files only)
```

Shares are for handing a file to an **external / unauthenticated** recipient. To do that, create one and follow the public download flow (see `receiving.md`):

```bash
POST {apiBase}/shares
Body: { "fileId": "{fileId}", "maxDownloads": 1 }
```

## Storage Stats

```bash
GET {apiBase}/stats
Returns: { totalFiles, totalFolders, totalSize, totalShares, totalDownloads }
```

## Drive Organization Tips

Recommended structure:
```
/
├── documents/      ← Reports, PDFs
├── projects/       ← Per-project folders
│   └── my-project/
├── skills/         ← Skill files and plugins
├── exports/        ← Content for sharing
└── archive/        ← Old files
```

Common patterns:
- **Organize into project**: upload with `"path": "/projects/my-project"`
- **Archive old files**: `PATCH /files/{id}` → `{"parentPath": "/archive"}`
- **Clean up**: `DELETE /files/{folderId}` removes the folder and everything inside
