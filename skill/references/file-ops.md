# File Operations

All endpoints require `Authorization: Bearer {AGENT_TOKEN}` header.
Read token from `.env`, read API base from `drive.json`.

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
```

Returns: `{ files: [{ id, name, path, parentPath, isFolder, size, contentType, createdAt, updatedAt }], path }`

Files are sorted: folders first, then files alphabetically.

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
Returns: { deleted: N }
```

**Deleting a folder removes everything inside it.** Associated share links are cleaned up via cascade.

## Download Your Own File

There is no direct download endpoint for authenticated users. Instead, create a temporary share:

```bash
POST {apiBase}/shares
Body: { "fileId": "{fileId}", "maxDownloads": 1 }
```

Then follow the public download flow (see `receiving.md`).

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
