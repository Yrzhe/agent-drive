# Shared Spaces API

A **Space** shares *existing* files/folders/memory by reference — no storage
duplication. Contributing an item never copies bytes; the underlying file stays
in the contributor's own drive and the memory row stays under its owner. P1
spaces are **invite-only** (`visibility: "invite"`); there is no public commons
yet (P2).

## Scopes

Spaces reuse the existing drive scopes — **no new scope string was introduced**:

| Operation | Scope |
|---|---|
| List / get / read members / read items | `read:drive` |
| Create / delete space, invite/remove/re-role members, contribute/remove items | `write:drive` |

The default `AGENT_TOKEN` grant (`read:drive write:drive share:create read:memory
write:memory path:/`) already covers every space endpoint. Path scopes
(`path:/prefix/*`) do **not** apply to spaces themselves — a space id is not a
drive path — but they still gate which of *your own* files you can contribute,
since `add_to_space` re-checks ownership through the normal file lookup.

## Identity requirement

Every space endpoint requires a real user identity (`403 identity_required` if
not): a browser session, or a bearer token bound to a specific user (an
OAuth token, a minted drive token, or the owner-bound `AGENT_TOKEN` on a
deployment with `OWNER_EMAIL` set). The **legacy deployment-wide `AGENT_TOKEN`**
on an `OWNER_EMAIL`-unset install has no user id to attribute a space to, so it
is rejected here — unlike files/folders, `spaces.creatorId` is `NOT NULL`.

## Roles

| Role | Read all items | Contribute (add) | Modify/remove own items | Modify/remove ANY item | Manage membership | Delete space |
|---|---|---|---|---|---|---|
| `viewer` | ✅ | — | — | — | — | — |
| `contributor` | ✅ | ✅ | ✅ | — | — | — |
| `editor` | ✅ | ✅ | ✅ | ✅ | — | — |
| `creator` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Roles are strictly ordered `viewer < contributor < editor < creator`. The
creator is whoever called `POST /spaces`; they never have their own
`space_members` row (their role is derived from `spaces.creatorId`), and they
cannot be added, re-roled, or removed as if they were a regular member.

### The live-reference edit consequence (read this before inviting an editor)

Space items are **references, not copies**. A file contributed to a space
still lives in the contributor's own drive at their own path — nothing is
duplicated. This has one important consequence:

> **An `editor` who overwrites a file you contributed is editing YOUR real
> file, in your own drive.** There is no fork, no shadow copy — the bytes at
> your original path change. This only applies to `editor`+; a `contributor`
> or `viewer` can never write through a space to a file they don't own,
> regardless of who contributed it.

Only grant `editor` to people you trust to co-edit your actual files. If you
only want others to *read* what you share, keep them at `viewer` or
`contributor`.

## Security boundaries

1. **Contributing is owner-explicit.** `POST /spaces/:id/items` verifies the
   `ref` resolves to a resource **you own** — you can never expose someone
   else's file, folder, or memory into a space. A non-owned or nonexistent ref
   both fail with the same `403 not_your_resource` (no existence leak).
2. **Cross-owner read is membership-gated everywhere**, not just inside the
   `/spaces` routes: `list_files`, `read_file`, `search_files`, file download
   presign, `recall`, memory list/get, and their MCP equivalents all widen to
   "my own rows UNION items in spaces I'm a member of." A non-member sees
   exactly what full owner isolation would show them — nothing extra.
3. **Removing a member retracts their contributions.** `DELETE
   /spaces/:id/members/:userId` (and the MCP `manage_space_members` with
   `remove: true`) also deletes every `space_items` row that member
   contributed to that space — their resources stop being reachable through
   it. The underlying files/memory are never touched, only the reference rows.
4. **Removing an item never deletes the resource.** `DELETE
   /spaces/:id/items/:itemId` removes the `space_items` reference row only.
5. `/api/public/v1/admin/*` stays completely outside the spaces model — no
   admin space endpoints exist, and none are documented here.

## REST endpoints

Base path: `/api/public/v1/spaces`. All require an authenticated user identity
(see above); `Authorization: Bearer <token>` or a browser session.

### Spaces

```
POST   /spaces                    Body { name }              → 201 { space }
GET    /spaces                                                → { spaces: [space, ...] }
GET    /spaces/:id                                             → { space }
DELETE /spaces/:id                (creator only)               → { deleted: true, id }
```

- `name` required, 1–200 chars (trimmed).
- Every space created here is `visibility: "invite"` (P1; the public commons
  is P2, not yet built).
- `GET /spaces` lists spaces you created plus spaces you're a member of.
- `GET /spaces/:id` by a non-member (or an id that doesn't exist) returns
  `404 space_not_found` — it never confirms whether the id is real.
- `DELETE /spaces/:id` removes the space's own `space_items` and
  `space_members` rows first, then the space row itself — reference rows
  only, never the underlying files/memory.

**Space object:**
```json
{
  "id": "abc123",
  "name": "Team KB",
  "visibility": "invite",
  "creatorId": "usr_...",
  "createdAt": "2026-07-19T00:00:00.000Z",
  "role": "creator",
  "memberCount": 1,
  "itemCount": 0
}
```
`role` is the CALLER's resolved role in this space (not a fixed property of
the space). `memberCount` includes the creator, who has no `space_members` row
of their own — except on a `visibility: "public"` space, where it is **`null`**
("everyone on this drive"): the public commons materializes no membership rows,
so a count there would report `1` for the space every user can read.

### Members

```
GET    /spaces/:id/members                                     → { members: [...] }
POST   /spaces/:id/members         Body { email, role }        (creator only) → 201 { member }
DELETE /spaces/:id/members/:userId (creator only)               → { removed: true, userId }
PATCH  /spaces/:id/members/:userId Body { role }  (creator only) → { member }
```

- `GET /members` requires `viewer`+ (any member can see the roster). The
  creator is synthesized into the list (`role: "creator"`, `addedBy: null`)
  since they have no stored row. On a `visibility: "public"` space it is
  **creator-only** (`403 space_forbidden` for anyone else): implicit membership
  satisfies `viewer` for every active user, and the roster exposes member email
  addresses. Item attribution is still available to everyone via each item's
  `contributedBy`.
- `POST /members` invites by **email of an existing user only** — v1 has no
  accept/decline step; the invited user is added directly and the space
  appears for them immediately (design D2). `404 user_not_found` if the email
  doesn't match an existing account. `role` must be one of `viewer`,
  `contributor`, `editor`. Re-inviting an existing member updates their role
  (upsert on `(spaceId, userId)`).
- The space creator can never be added, re-roled, or removed as a member
  (`400 validation_error`) — they aren't a `space_members` row to begin with.
- `DELETE /members/:userId` also retracts everything that member contributed
  to the space (see Security boundaries above). `404 member_not_found` if
  they aren't currently a member.
- `PATCH /members/:userId` changes an existing member's role. `404
  member_not_found` if they aren't currently a member.

**Member object:**
```json
{ "userId": "usr_...", "email": "a@example.com", "role": "editor", "addedBy": "usr_creator", "addedAt": "2026-07-19T00:00:00.000Z" }
```

### Items

```
POST   /spaces/:id/items          Body { itemType, ref }       → 201 { item }
GET    /spaces/:id/items          ?type=file|folder|memory&limit=&offset=  → { items, limit, offset }
DELETE /spaces/:id/items/:itemId                                 → { removed: true, id }
```

- `POST /items` requires `contributor`+. `itemType` is `file`, `folder`, or
  `memory`; `ref` is a drive path (for `file`/`folder`) or a memory id/key
  (for `memory`). The ref must resolve to a resource **you own** — see
  Security boundary #1. Idempotent: contributing the same
  `(spaceId, itemType, itemRef)` twice returns the existing item rather than
  erroring.
- `GET /items` requires `viewer`+. Returns a **flat, attributed list** — each
  item shows who contributed it — not a merged path tree (avoids
  cross-contributor path collisions, e.g. two members both having `/notes.md`).
  A `folder` item is a single entry; browsing its subtree is done by
  drilling into the ordinary `list_files`/`GET /files` surface once the
  member's read-path union makes those descendants visible. `type` filters to
  one item type; `limit`/`offset` paginate (default 50, max 200).
- `DELETE /items/:itemId` requires `contributor`+. You may remove your own
  items freely; removing another member's item requires `editor`+
  (`403 space_forbidden` otherwise). Removes the reference row only.

**Item object (flat, attributed):**
```json
{
  "id": "itm_...",
  "itemType": "file",
  "itemRef": "file_abc123",
  "name": "report.pdf",
  "contributedBy": "usr_...",
  "addedAt": "2026-07-19T00:00:00.000Z"
}
```
`name` is resolved from the underlying resource (file/folder name, or a
memory's `key`, falling back to a content snippet); `null` means the
underlying resource was hard-deleted since it was contributed — the stale
reference row itself is left for you to clean up explicitly.

## MCP tools

Six tools, all requiring a real user identity (see above). Scope column shows
`requiredScope`; there is no new scope — spaces reuse `read:drive`/`write:drive`.

| Tool | Scope | Input | Notes |
|---|---|---|---|
| `list_spaces` | `read:drive` | `{}` | Spaces you created + are a member of, with role and counts |
| `read_space` | `read:drive` | `{ space, type? }` | Flat attributed item list; `type` optionally filters `file`\|`folder`\|`memory` |
| `add_to_space` | `write:drive` | `{ space, type, path? , memory_key? }` | `path` for `file`/`folder`, `memory_key` for `memory`. Must own the resource. |
| `remove_from_space` | `write:drive` | `{ space, item_id }` | Own items freely; others' items need `editor`+ |
| `create_space` | `write:drive` | `{ name }` | You become `creator` |
| `manage_space_members` | `write:drive` | `{ space, email, role?, remove? }` | Creator only. Pass `role` to add/update, or `remove: true` to remove |

JSON-RPC error `message` is the same colon-delimited `code:description` format
used elsewhere in this API (e.g. `space_forbidden:...`).

## Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `validation_error` | Bad `name`/`role`/`itemType`/`ref`, or an attempt to touch the space creator as if they were a regular member |
| 403 | `identity_required` | No resolvable user identity on the request (session or user-bound bearer only — the legacy global `AGENT_TOKEN` cannot use spaces) |
| 403 | `space_forbidden` | Caller's role in the space is below what the operation requires |
| 403 | `not_your_resource` | `ref` passed to `POST /spaces/:id/items` doesn't resolve to a live resource the caller owns (same code for "doesn't exist" and "exists but belongs to someone else") |
| 404 | `space_not_found` | Space doesn't exist, or caller isn't a member (GET by a non-member 404s rather than 403s, so it never confirms the id is real) |
| 404 | `member_not_found` | Target user isn't currently a member of the space |
| 404 | `item_not_found` | Item id doesn't belong to this space |
| 404 | `user_not_found` | `POST /spaces/:id/members` — no existing user with that email |

## What's out of scope in P1

- The public commons (one instance-wide `visibility: "public"` space) — P2.
- Accept/decline on invite — a member is added directly (design D2).
- Copy-on-contribute — spaces are references only, by design.
- Per-item roles, nested spaces, real-time collaboration/locking, audit of
  who-read-what.
- `/api/public/v1/admin/*` has no space-related surface.

See also: [`../implementation/2026-07-19-shared-spaces-design.md`](../implementation/2026-07-19-shared-spaces-design.md)
for the full design rationale (gitignored — internal only, not shipped with
the public repo).
