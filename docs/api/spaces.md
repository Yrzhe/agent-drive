# Shared Spaces API

A **Space** shares *existing* files/folders/memory by reference — no storage
duplication. Contributing an item never copies bytes; the underlying file stays
in the contributor's own drive and the memory row stays under its owner. Most
spaces are **invite-only** (`visibility: "invite"`, P1) — someone with
`write:drive` creates one and invites members by email. There is also exactly
ONE **public commons** (`visibility: "public"`, P2): an instance-wide space
every **active** user of this deployment implicitly belongs to. See
[The public commons](#the-public-commons) below — read it before contributing
anything there, since publishing to it is a one-way visibility change for
every other user.

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

**On the public commons the table above still describes what each role can
DO, but `editor` no longer means "can overwrite files" — see below.**

### The public commons

There is exactly **one** instance-wide `visibility: "public"` space per
deployment — the **commons**. It is system-bootstrapped on first use (any
spaces request materializes it if it doesn't exist yet); `creatorId` is
always the deployment owner (`OWNER_EMAIL`), which makes the owner the
commons' sole default moderator. **Users cannot create a public space** —
`POST /spaces` always creates a `visibility: "invite"` space, no matter who
calls it.

- **Every ACTIVE user is implicitly a `contributor`.** There is no
  `space_members` row to accept or manage — membership just follows account
  status. A `pending`/`suspended` user gets nothing: the same access gate
  that denies their other requests denies the commons too.
- **You can read everything in the commons and contribute your OWN
  files/memory.** Contributing is still owner-explicit (Security boundary #1
  below) — you can never publish a resource you don't own.
- **Folders are not accepted.** `POST /spaces/:id/items` with
  `itemType: "folder"` on the commons fails `400
  folders_not_allowed_in_public` — a folder item exposes its *entire live
  subtree*, including files added to it later, which is too open-ended for
  an instance-wide space. Contribute individual files instead. Invite spaces
  are unaffected — they still accept folders.
- **You can only withdraw your OWN item.** `DELETE
  /spaces/:id/items/:itemId` on the commons succeeds for the contributor
  removing their own item, or for the commons creator/an explicit
  commons-editor moderating (see next point) — never for an ordinary
  fellow contributor removing someone else's item (`403 space_forbidden`).
- **Moderation is reference-removal ONLY — never rewriting bytes.** This is
  the one place `editor` means something different from an invite space: an
  explicit `editor` row on the commons lets that user remove *any* item
  (moderation), but it grants **no write access to the underlying file**.
  Compare to an invite space, where a live-reference `editor` genuinely
  overwrites the contributor's real file (see the next section) — that power
  is deliberately excluded on the commons. Publishing to the commons is
  consent to be *read*, never consent to have your bytes replaced.
- **The owner can demote or delegate moderation with an explicit row.** The
  commons creator (owner) can `POST /spaces/:id/members` a specific user a
  `viewer` row (read-only — that user can no longer contribute) or an
  `editor` row (item-moderation delegate, still no file-write power). No row
  at all means the implicit `contributor` floor. A stored row on the commons
  is authoritative in **both** directions — it can promote above, or demote
  below, the implicit floor.
- **`memberCount` is `null`, never a number.** The commons materializes no
  `space_members` rows, so counting them would report `1` — the smallest
  number in the list — for the one space every active user can actually
  read. Render/describe it as **"everyone on this drive"**, not as a count.
- **The member roster is creator-only.** `GET /spaces/:id/members` on the
  commons returns `403 space_forbidden` to everyone except the creator — it
  would otherwise hand every active user's email address (via implicit
  `viewer`+) to the whole deployment. Item attribution still reaches
  everyone through each item's `contributedBy`.

> **Publishing consequence — read before contributing on someone's behalf.**
> Contributing a file or memory to the commons makes it readable by **every
> active user of this deployment**, immediately. An agent must never
> contribute to the commons on a human's behalf without their explicit
> intent — this is not the same action as saving a file to the drive, and
> should never be a side effect of another task.

### The live-reference edit consequence (read this before inviting an editor)

Space items are **references, not copies**. A file contributed to a space
still lives in the contributor's own drive at their own path — nothing is
duplicated. This has one important consequence, **on invite spaces only**:

> **An `editor` who overwrites a file you contributed is editing YOUR real
> file, in your own drive.** There is no fork, no shadow copy — the bytes at
> your original path change. This only applies to `editor`+; a `contributor`
> or `viewer` can never write through a space to a file they don't own,
> regardless of who contributed it.

Only grant `editor` to people you trust to co-edit your actual files. If you
only want others to *read* what you share, keep them at `viewer` or
`contributor`.

**This write consequence does not exist on the public commons.** An `editor`
row there is moderation-only (see [The public commons](#the-public-commons)
above) — it can never overwrite another contributor's file, by design.

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
6. **The commons never grants a byte-level write.** `editor` is excluded
   outright on `visibility: "public"` spaces from the write-relaxation path
   that lets an invite-space editor overwrite a contributor's file — an
   owner-granted commons `editor` row can moderate (remove) items but can
   never change what's inside them. See [The public
   commons](#the-public-commons).
7. **Folders are rejected on the commons (D4).** `POST /spaces/:id/items`
   with `itemType: "folder"` against a `visibility: "public"` space fails
   `400 folders_not_allowed_in_public` before the ownership check even runs
   — a folder's live subtree is too open-ended to publish instance-wide.

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
- `POST /spaces` always creates a `visibility: "invite"` space — users cannot
  create a public space. There is exactly one commons, system-bootstrapped
  (see [The public commons](#the-public-commons)); it is never created by
  this endpoint.
- `GET /spaces` lists spaces you created, plus spaces you're a member of,
  **plus the commons** (`visibility: "public"`) when you're an active user
  — it appears with `role: "contributor"` (or whatever explicit role the
  owner set for you there) even though you never "joined" it.
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
- **On the public commons**, `POST /members` is not really an "invite" (the
  target is already an implicit `contributor`) — it's an **override**: a
  `viewer` row demotes them to read-only, an `editor` row delegates item
  moderation (never file-write, see [The public
  commons](#the-public-commons)). Only the commons creator can call this.
- `DELETE /members/:userId` also retracts everything that member contributed
  to the space (see Security boundaries above). `404 member_not_found` if
  they aren't currently a member. **On the commons this is the same
  endpoint doing double duty** — it deletes their override row (so they fall
  back to the implicit `contributor` floor, not to no-access) **but it also
  retracts every item they contributed while that row existed.** To undo a
  `viewer` demotion without wiping the user's contributions, `PATCH
  /members/:userId` back to `contributor` instead of `DELETE`-ing the row.
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
  erroring. **On a `visibility: "public"` space, `itemType: "folder"` fails
  `400 folders_not_allowed_in_public`** before the ownership check runs (D4)
  — only `file` and `memory` may be contributed to the commons.
- `GET /items` requires `viewer`+. Returns a **flat, attributed list** — each
  item shows who contributed it — not a merged path tree (avoids
  cross-contributor path collisions, e.g. two members both having `/notes.md`).
  A `folder` item is a single entry; browsing its subtree is done by
  drilling into the ordinary `list_files`/`GET /files` surface once the
  member's read-path union makes those descendants visible. `type` filters to
  one item type; `limit`/`offset` paginate (default 50, max 200).
- `DELETE /items/:itemId` requires `contributor`+. You may remove your own
  items freely; removing another member's item requires `editor`+
  (`403 space_forbidden` otherwise). Removes the reference row only. **On
  the commons**, "removing another member's item" in practice means the
  commons creator (owner), or a user the owner explicitly promoted to
  `editor` there — an ordinary implicit `contributor` can only withdraw
  their own item, never anyone else's (see [The public
  commons](#the-public-commons)).

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
Every one of these tools bootstraps the commons on first use, the same way
the REST routes do — an agent never needs to know it exists ahead of time.

| Tool | Scope | Input | Notes |
|---|---|---|---|
| `list_spaces` | `read:drive` | `{}` | Spaces you created + are a member of, **plus the public commons** for any active user, with role and counts |
| `read_space` | `read:drive` | `{ space, type? }` | Flat attributed item list; `type` optionally filters `file`\|`folder`\|`memory` |
| `add_to_space` | `write:drive` | `{ space, type, path? , memory_key? }` | `path` for `file`/`folder`, `memory_key` for `memory`. Must own the resource. `type: "folder"` into the commons fails `folders_not_allowed_in_public`. **Contributing to the commons publishes to every active user of this deployment — never do this on a human's behalf without explicit intent.** |
| `remove_from_space` | `write:drive` | `{ space, item_id }` | Own items freely; others' items need `editor`+. On the commons that means the creator (owner) or an owner-delegated editor — an implicit contributor can only withdraw their own item. |
| `create_space` | `write:drive` | `{ name }` | You become `creator`. Always creates an invite space — you cannot create a public one. |
| `manage_space_members` | `write:drive` | `{ space, email, role?, remove? }` | Creator only. Pass `role` to add/update, or `remove: true` to remove. On the commons this overrides (demotes to `viewer` / delegates moderation via `editor`) an already-implicit member rather than inviting a stranger. |

JSON-RPC error `message` is the same colon-delimited `code:description` format
used elsewhere in this API (e.g. `space_forbidden:...`).

## Error codes

| Status | Code | Meaning |
|---|---|---|
| 400 | `validation_error` | Bad `name`/`role`/`itemType`/`ref`, or an attempt to touch the space creator as if they were a regular member |
| 400 | `folders_not_allowed_in_public` | Tried to contribute `itemType: "folder"` to the public commons — only `file` and `memory` are accepted there (D4) |
| 403 | `identity_required` | No resolvable user identity on the request (session or user-bound bearer only — the legacy global `AGENT_TOKEN` cannot use spaces) |
| 403 | `space_forbidden` | Caller's role in the space is below what the operation requires |
| 403 | `not_your_resource` | `ref` passed to `POST /spaces/:id/items` doesn't resolve to a live resource the caller owns (same code for "doesn't exist" and "exists but belongs to someone else") |
| 404 | `space_not_found` | Space doesn't exist, or caller isn't a member (GET by a non-member 404s rather than 403s, so it never confirms the id is real) |
| 404 | `member_not_found` | Target user isn't currently a member of the space |
| 404 | `item_not_found` | Item id doesn't belong to this space |
| 404 | `user_not_found` | `POST /spaces/:id/members` — no existing user with that email |

## What's still out of scope

- Users creating additional public/instance-wide spaces — there is exactly
  ONE commons, system-bootstrapped; `POST /spaces` always creates
  `visibility: "invite"`.
- Accept/decline on invite — a member is added directly (design D2). This
  is moot on the commons anyway, since membership there is implicit.
- Copy-on-contribute — spaces are references only, by design.
- Per-item roles, nested spaces, real-time collaboration/locking, audit of
  who-read-what.
- `/api/public/v1/admin/*` has no space-related surface.

See also: [`../implementation/2026-07-19-shared-spaces-design.md`](../implementation/2026-07-19-shared-spaces-design.md)
for the full design rationale (gitignored — internal only, not shipped with
the public repo).
