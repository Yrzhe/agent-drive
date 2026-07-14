# Activity Log API

Read the drive's activity log — uploads, share access/downloads, trash/restore/purge, memory writes, peering deliveries, token mints, etc. Useful for audit trails and for an agent to see what has happened since it last checked. Rows are retained ~30 days (older ones are pruned opportunistically). Note: authenticated **owner** file previews (`GET /files/:id/preview`) are not logged — only public share downloads are.

Base: `<YOUR_AGENT_DRIVE_URL>/api/public/v1/activity`

## Auth & scope

Standard bearer/session auth; capability scope `read:drive`. **Path-scoped tokens see a filtered view**: an event is visible only when its `targetPath` falls within the token's granted prefix. Admin-style events with no `targetPath` (share/webhook management) are visible only to tokens without a path restriction.

## Endpoint

### List — `GET /v1/activity?type=&since=&limit=`

| Param | Notes |
|---|---|
| `type` | Optional event-type filter, e.g. `file.uploaded`, `share.accessed`, `memory.created`. |
| `since` | Optional ISO-8601 timestamp; only events at/after it. `400 validation_error` if not a valid timestamp. |
| `limit` | 1–200, default 50. |

Returns:

```json
{
  "activities": [
    {
      "id": "...",
      "eventType": "share.accessed",
      "targetType": "share",
      "targetId": "...",
      "targetPath": "/reports/q3.pdf",
      "actor": "owner",
      "metadata": { "...": "event-specific, never includes file contents or secrets" },
      "createdAt": "2026-07-14T10:00:00Z"
    }
  ]
}
```

`actor` is `owner` (session/AGENT_TOKEN) or `agent` (a minted/OAuth bearer). Common `eventType`s: `file.uploaded` / `file.trashed` / `file.moved` / `file.purged`, `share.created` / `share.accessed` / `share.downloaded`, `memory.created` / `memory.updated` / `memory.deleted`, `contact.added` / `file.sent` / `inbox.received`, `token.minted` / `token.revoked`.
