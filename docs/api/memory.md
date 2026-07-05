# Memory API

Persistent agent memory with FTS5 full-text search. Designed as the agent's external brain: write conclusions at session end, recall them at session start. Content is text-only (max 8 KB per memory) — large artifacts belong in the drive with a memory pointing at the path.

## Scopes

| Operation | Scope |
|---|---|
| recall / list / get | `read:memory` |
| remember / forget | `write:memory` |

Both are included in the default `AGENT_TOKEN` grant and can be approved on the OAuth consent screen. Path scopes do not apply to memories (they have no path).

## MCP tools

| Tool | Input | Returns |
|---|---|---|
| `remember` | `{ content, key?, tags?, source? }` | `{ memory, created }` |
| `recall` | `{ query, limit? }` | `{ query, count, memories }` |
| `list_memories` | `{ limit?, offset? }` | `{ count, offset, memories }` |
| `forget` | `{ id }` (id or key) | `{ forgotten }` |

`key` gives upsert semantics: a `remember` with an existing key updates that memory in place (`created: false`). Recommended key style: `project:agent-drive:deploy-notes`.

`recall` uses SQLite FTS5 with per-token prefix matching; multi-word queries AND together, results are relevance-ranked.

## REST endpoints

All under owner auth (`Authorization: Bearer <token>`).

| Method | Endpoint | Body / Query | Returns |
|---|---|---|---|
| POST | `/api/public/v1/memory` | `{ content, key?, tags?, source? }` | `201 { memory, created }` (200 on key update) |
| GET | `/api/public/v1/memory` | `?limit=20&offset=0` | `{ memories, count }` |
| GET | `/api/public/v1/memory/search` | `?q={query}&limit=10` | `{ query, memories, count }` |
| GET | `/api/public/v1/memory/{idOrKey}` | — | `{ memory }` |
| DELETE | `/api/public/v1/memory/{idOrKey}` | — | `{ forgotten }` |

## Memory object

```json
{
  "id": "V1StGXR8_Z5jdHi6B-myT",
  "key": "project:agent-drive:deploy-notes",
  "content": "Deploy needs AGENT_TOKEN_SCOPES var; drizzle-kit required by migration checks.",
  "tags": ["deploy", "gotcha"],
  "source": "claude-code",
  "createdAt": "2026-07-05T12:00:00.000Z",
  "updatedAt": "2026-07-05T12:00:00.000Z"
}
```

## Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `validation_error` | Missing/oversized content (8 KB max), key > 256 chars, empty query |
| 403 | `invalid_scope` | Token lacks the required memory scope |
| 404 | `memory_not_found` | No memory with that id or key |

## Activity events

`memory.created`, `memory.updated`, `memory.deleted` are logged to the activity feed (metadata carries `key` and `tags`, never content) and fan out to webhooks.
