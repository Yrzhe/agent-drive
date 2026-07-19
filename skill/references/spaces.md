# Shared Spaces

Share your *existing* files, folders, and memories with other users **by
reference** — no copies, no separate upload. A Space is a shared shelf other
people put their stuff on too; you read the whole shelf, and you can only put
your own stuff on it.

## When to use

- You want to give a teammate read access to a file or folder without sending
  it or re-uploading it somewhere shared
- Someone invited you to a space and you want to see what's in it
- You want to build a small team knowledge base out of memories multiple
  people contribute to
- You got a `space_forbidden` or `not_your_resource` error and need to know why

## The model in one paragraph

A **Space** has members with **roles**. Any member can **read** everything in
the space. A **contributor**+ can **add their own** files/folders/memories to
it (never someone else's — you can only share what you own). An **editor**
can add or remove *any* item, and — this is the part to internalize —
**can overwrite a file someone else contributed**, because items are live
references, not copies: editing it edits the contributor's real file in
their own drive. Only the **creator** manages membership and can delete the
space.

| Role | Read | Add your own | Remove your own | Remove/edit anyone's |
|---|---|---|---|---|
| viewer | ✅ | | | |
| contributor | ✅ | ✅ | ✅ | |
| editor | ✅ | ✅ | ✅ | ✅ |
| creator | ✅ | ✅ | ✅ | ✅ (+ manage members, delete space) |

P1 spaces are invite-only — someone with `write:drive` creates a space and
invites members by email. There's no public/instance-wide space yet.

## Discover your spaces

```
list_spaces  {}
→ { spaces: [{ id, name, role, memberCount, itemCount, creatorId, createdAt, visibility }, ...] }
```

Lists every space you created plus every space you were invited into, along
with **your** role in each. Empty array if you have none.

## Read a space

```
read_space  { space: "<space id>", type?: "file"|"folder"|"memory" }
→ { space, items: [{ id, itemType, itemRef, name, contributedBy, addedAt }, ...] }
```

This is a **flat, attributed list** — who added what, not a merged folder
tree (two contributors could both have a `/notes.md`, so items don't get
merged into one path namespace). To read the actual contents of a shared
file/folder, use the normal drive tools (`read_file`, `list_files`) — once
you're a member, your reads automatically widen to include space-contributed
resources at their original owner's path. A folder item's whole subtree
becomes visible this way; you don't need to enumerate it through
`read_space`.

Requires `viewer`+. A space you're not a member of (or that doesn't exist)
returns `space_not_found` — same error either way, so you can't probe for
real space ids.

## Contribute your own resource

```
add_to_space  { space: "<id>", type: "file"|"folder"|"memory", path?: "<drive path>", memory_key?: "<id or key>" }
→ { item: { id, itemType, itemRef, name, contributedBy, addedAt } }
```

Use `path` for `file`/`folder`, `memory_key` for `memory`. **You can only
contribute a resource you own** — the server re-verifies ownership
server-side regardless of what the space's role table says, so there is no
way to accidentally (or deliberately) expose someone else's file into a
space you're a member of. A path/id that isn't yours or doesn't exist both
fail the same way (`not_your_resource`) — the error never reveals whether
something exists under another owner.

Requires `contributor`+. Idempotent — contributing the same resource twice
returns the existing item.

## Remove an item

```
remove_from_space  { space: "<id>", item_id: "<from read_space>" }
→ { removed: true, id }
```

This only deletes the **reference row** — the underlying file/memory is
completely untouched. You can always remove your own contributions.
Removing someone else's item requires the `editor` role.

## Create a space and manage members

```
create_space  { name: "<space name>" }
→ { space: { id, name, role: "creator", ... } }

manage_space_members  { space: "<id>", email: "<user's email>", role?: "viewer"|"contributor"|"editor", remove?: true }
→ { member: {...} }   or   { removed: true, userId }
```

Creator-only. `manage_space_members` invites-or-updates by default (pass
`role`); pass `remove: true` instead to remove that member. Invites target an
**existing user's email only** — v1 has no pending-invite/accept step, they
appear as a member immediately. You cannot touch the space creator through
this tool (they aren't a regular member). Removing a member also retracts
everything they contributed to that space — their stuff stops being shared,
though it's never deleted from their own drive.

## The live-edit warning (read before granting `editor`)

Because a space item is a **reference**, not a copy, `editor` is a real write
grant on someone else's file. If you contribute a file to a space and grant
someone `editor`, they can overwrite that file — the change lands in **your**
drive, at your original path, not in some space-owned copy. This is
deliberate (the whole point of "no storage duplication"), but it means:

- Only promote people to `editor` if you're comfortable with them editing
  your actual files.
- `contributor` and `viewer` can never write through a space to a file they
  don't own — the write grant is strictly tied to `editor`+.
- This has no effect on memory items — memory writes (`remember`/`forget`)
  are never widened through a space in P1; a member can only read a shared
  memory, never edit or delete it.

## Errors you'll see

| Code | What it means |
|---|---|
| `identity_required` | Spaces need a real user identity — the legacy install-wide `AGENT_TOKEN` (no `OWNER_EMAIL` set) can't use them. A user-bound token (OAuth, a minted drive token, or an `OWNER_EMAIL`-bound `AGENT_TOKEN`) works. |
| `space_forbidden` | Your role in the space is below what the call needs (e.g. a viewer calling `add_to_space`) |
| `not_your_resource` | The `path`/`memory_key` you tried to contribute isn't a live resource you own |
| `space_not_found` | The space doesn't exist, or you aren't a member (same error for both — no existence leak) |
| `member_not_found` | That email isn't currently a member of the space |
| `item_not_found` | That item id isn't in this space |

## REST equivalents

Every MCP tool above has a REST counterpart under `/api/public/v1/spaces` —
full contract, request/response shapes, and pagination in
`docs/api/spaces.md` if you're integrating over plain HTTP instead of MCP.
