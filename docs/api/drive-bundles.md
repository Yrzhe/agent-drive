# Drive Bundles API

The `bundles` surface is what `adrive sync` talks to. It adds optimistic concurrency (If-Match) and per-bundle version history on top of the regular file storage.

> All endpoints live under `<YOUR_AGENT_DRIVE_URL>/api/public/v1/bundles/...` and require the same auth as the rest of `/api/public/v1/*` (OAuth bearer or `AGENT_TOKEN`). See [`oauth.md`](./oauth.md) for details.

## Concepts

A **bundle** is a folder in the drive treated as a single versioned unit (e.g. `/skills/learn`). Each commit assigns it a new `versionId` (`dv_<10char>`) and snapshots the previous manifest to `${prefix}/.history/<previousVersionId>.json`.

The current manifest lives at the well-known path `${prefix}/manifest.json` and contains:

```json
{
  "version": 1,
  "name": "learn",
  "hash": "<sha256-of-bundle-files>",
  "machineId": "<machine that pushed this version>",
  "pushedAt": "2026-05-13T15:30:00.000Z",
  "versionId": "dv_abc123xyz0",
  "previousVersionId": "dv_def456uvw9",
  "fileCount": 12,
  "totalSize": 8421,
  "files": [
    { "path": "SKILL.md", "size": 1024, "hash": "sha256:..." },
    ...
  ],
  "directories": ["references"]
}
```

Server-side state lives in the `bundle_versions` table (`prefix` PK, `currentVersionId`, `previousVersionId`, `machineId`, `hash`, `fileCount`, `totalSize`, `pushedAt`, `updatedAt`). File bodies (including manifest and `.history/*` snapshots) live in R2 as normal `files` rows.

## `POST /api/public/v1/bundles/commit`

Atomically swing the bundle's current version.

**Request:**

```json
{
  "prefix": "/skills/learn",
  "ifMatch": "dv_def456uvw9",
  "manifest": {
    "version": 1,
    "name": "learn",
    "hash": "sha256:...",
    "machineId": "host-abc",
    "fileCount": 12,
    "totalSize": 8421,
    "files": [...],
    "directories": [...]
  }
}
```

**`ifMatch` semantics:**

| Value | Meaning |
|---|---|
| `null` (or omitted) | Fresh push only. Returns 412 if the bundle already has a version. |
| `"dv_<id>"` | Must equal the cloud's current `versionId`. Returns 412 otherwise. |
| `"*"` | Force — bypass the check (escape hatch). |

**Response (200):**

```json
{
  "versionId": "dv_abc123xyz0",
  "previousVersionId": "dv_def456uvw9",
  "pushedAt": "2026-05-13T15:30:00.000Z",
  "manifestPath": "/skills/learn/manifest.json",
  "hash": "sha256:...",
  "fileCount": 12,
  "totalSize": 8421
}
```

**412 Precondition Failed:**

```json
{
  "error": {
    "code": "version_conflict",
    "message": "Cloud bundle moved to dv_xyz since your last sync (you saw dv_old)",
    "currentVersionId": "dv_xyz"
  }
}
```

**Atomicity:** the pointer UPDATE is conditional on the prior `currentVersionId`. Two concurrent commits with the same `ifMatch` resolve to one winner and one 412 — no race window. R2 object writes (new manifest + history snapshot) happen before the DB swap; if the DB swap fails, R2 has orphan objects but the visible state didn't change (GC future-work).

**Notes:**

- File bodies are not in this payload. Upload them separately via the existing `write_file` MCP tool (or the upload presigned-URL flow). The commit only stamps the manifest pointer.
- `prefix` cannot be `/` and cannot target the `.history` directory.
- The `manifest.json` row is upserted automatically; you don't need to call `write_file` on it.
- A `bundle.committed` activity event is logged with `{ versionId, previousVersionId, hash, machineId, fileCount, totalSize, force }`.

## `GET /api/public/v1/bundles/current?prefix=...`

Read the current version pointer.

**Response (200):**

```json
{
  "prefix": "/skills/learn",
  "currentVersion": {
    "versionId": "dv_abc123xyz0",
    "previousVersionId": "dv_def456uvw9",
    "machineId": "host-abc",
    "hash": "sha256:...",
    "fileCount": 12,
    "totalSize": 8421,
    "pushedAt": "2026-05-13T15:30:00.000Z"
  }
}
```

If the bundle has never been committed: `{ "prefix": "...", "currentVersion": null }`.

## `GET /api/public/v1/bundles/history?prefix=...&limit=N`

List historical versions for a bundle. `limit` defaults to 50, max 200.

**Response (200):**

```json
{
  "prefix": "/skills/learn",
  "currentVersionId": "dv_abc123xyz0",
  "history": [
    {
      "versionId": "dv_def456uvw9",
      "previousVersionId": "dv_ghi789rst8",
      "hash": "sha256:...",
      "machineId": "host-abc",
      "pushedAt": "2026-05-13T14:00:00.000Z",
      "fileCount": 11,
      "totalSize": 8200
    },
    ...
  ]
}
```

History is parsed from the `${prefix}/.history/*.json` snapshot files, sorted by `pushedAt` desc. The CURRENT version is NOT in `history` (it lives at `${prefix}/manifest.json`); use `/current` for that.

## `GET /api/public/v1/bundles/manifest?prefix=...&versionId=dv_xxx`

Fetch the full manifest body for a specific version (current or historical). Used by client-side rollback to read a target manifest before re-committing it.

**Response (200):**

```json
{
  "prefix": "/skills/learn",
  "versionId": "dv_def456uvw9",
  "manifest": { ...full manifest body as committed... }
}
```

Returns 404 if the version doesn't exist or its body is missing from storage.

## Rollback (client-side)

There's no server-side `rollback` endpoint. Rollback is sugar for "commit a historical manifest as the new version":

```bash
# Conceptually:
target = GET /bundles/manifest?prefix=/skills/learn&versionId=dv_old
current = GET /bundles/current?prefix=/skills/learn
POST /bundles/commit {
  prefix: "/skills/learn",
  ifMatch: current.currentVersion.versionId,
  manifest: target.manifest        # re-commit the old manifest
}
```

`adrive sync rollback /skills/learn --to dv_old` does exactly this.

**Important caveat:** rollback restores the manifest pointer ONLY. File bytes at `${prefix}/<file>` are NOT modified. If files were deleted between the target version and now, they cannot be recovered automatically — re-push from a local copy if you need their contents back. The CLI prompts the user about this before proceeding.

## Backwards compatibility

- Bundles pushed by older CLIs (no versioning) have no `bundle_versions` row. The first commit on a versioned CLI will INSERT the row (ifMatch must be null or `*`).
- Older CLIs continue to write `manifest.json` directly via the `write_file` MCP tool. That path is untouched. Mixed-version usage works: once a versioned commit happens, subsequent commits enforce ETag.

## Rate limits

Inherits the global `/api/public/v1/*` per-token throttling (see [`README.md`](./README.md#rate-limits)). No dedicated per-endpoint cap today.

## Error format

Same `{ "error": { "code", "message", ... } }` shape as the rest of the v1 surface. Version-conflict responses include an extra `currentVersionId` field on the error object.
