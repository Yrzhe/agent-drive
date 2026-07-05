# Memory

Persistent agent memory with full-text search. Use it as your external brain: write conclusions at the end of a session, recall them before starting the next one.

## When to use

- End of a work session → `remember` key decisions, open questions, gotchas
- Start of a work session → `recall` prior context before re-deriving anything
- Stable facts that must survive context resets (deploy URLs, conventions, owner preferences)

## Scopes

`read:memory` for recall/list, `write:memory` for remember/forget. The default `AGENT_TOKEN` grant includes both; OAuth tokens need them approved at consent.

## MCP tools (preferred)

```
remember      { content, key?, tags?, source? }   → { memory, created }
recall        { query, limit? }                   → { query, count, memories }
list_memories { limit?, offset? }                 → { count, offset, memories }
forget        { id }                              → { forgotten }   # id or key
```

- `content` is required, max 8 KB. Store text, not files — large artifacts belong in the drive with a memory pointing at the path.
- `key` gives upsert semantics: `remember` with an existing key updates that memory in place. Use hierarchical keys like `project:agent-drive:deploy-notes`.
- `recall` is FTS5 full-text search with prefix matching, best match first. Multi-word queries AND together.
- `tags` is a string array for organizing; `source` records which agent/session wrote it.

## REST equivalents

```
POST   /api/public/v1/memory            { content, key?, tags?, source? } → 201 { memory, created }
GET    /api/public/v1/memory            ?limit=20&offset=0                → { memories, count }
GET    /api/public/v1/memory/search     ?q={query}&limit=10               → { query, memories, count }
GET    /api/public/v1/memory/{idOrKey}                                    → { memory }
DELETE /api/public/v1/memory/{idOrKey}                                    → { forgotten }
```

Auth: `Authorization: Bearer {TOKEN}`, same as all v1 endpoints.

## Memory object

```json
{
  "id": "nanoid",
  "key": "project:agent-drive:deploy-notes",
  "content": "Deploy needs AGENT_TOKEN_SCOPES var set; drizzle-kit is required by migration checks.",
  "tags": ["deploy", "gotcha"],
  "source": "claude-code",
  "createdAt": "2026-07-05T12:00:00.000Z",
  "updatedAt": "2026-07-05T12:00:00.000Z"
}
```

## Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `validation_error` | Missing/oversized content, bad key, empty query |
| 403 | `invalid_scope` | Token lacks `read:memory` / `write:memory` |
| 404 | `memory_not_found` | No memory with that id or key |
