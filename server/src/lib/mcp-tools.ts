import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { driveObjectKey } from "./object-keys";

import { buckets, files, shares, spaceItems, spaceMembers, spaces } from "@defs";

import { hashPassword } from "./crypto";
import { ensureFolderChain, nowIso, toFileObject } from "./files";
import { forgetMemory, listMemories, recallMemories, rememberMemory } from "./memory";
import { getContactByName, sendFileToContact } from "./peering";
import { escapedDescendantPattern, normalizeName, normalizePath, parentOfPath } from "./paths";
import { extractPathPrefixes, hasScope, pathAllowed, requirePathAllowed, type McpScope } from "./mcp-scopes";
import {
  assertSpaceRole,
  canEditFileViaSpace,
  fileReadableFilter,
  memoryReadableFilter,
  resolveOwnedContributionRef,
  resolveSpaceRole,
  resolveUserIdByEmail,
  spaceCounts,
  toDisplayItems,
  toSpaceSummary,
  userSpaceIds,
  type SpaceItemType,
} from "./spaces";
import { checkTotalQuota, MCP_READ_FILE_MAX_BYTES, MCP_WRITE_FILE_MAX_BYTES } from "./quota";
import { purgeConflictingTrashAtPath } from "./trash";
import type { AppDb } from "../types";

interface McpToolDefinition {
  name: string;
  description: string;
  requiredScope: McpScope;
  inputSchema: Record<string, unknown>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const stringArg = (input: Record<string, unknown>, key: string, required = true): string | null => {
  const value = input[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new Error(`invalid_params:${key} is required`);
  return null;
};

const rawStringArg = (input: Record<string, unknown>, key: string, required = true): string | null => {
  const value = input[key];
  if (typeof value === "string") return value;
  if (required) throw new Error(`invalid_params:${key} is required`);
  return null;
};

const numberArg = (input: Record<string, unknown>, key: string, fallback: number): number => {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

function escapeLikeQuery(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function objectPathForWrite(fileId: string, filename: string): string {
  return driveObjectKey(fileId, filename);
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_files",
    description: "List files and folders at an Agent Drive path.",
    requiredScope: "read:drive",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path to list. Defaults to /." },
        recursive: { type: "boolean", description: "Whether to list descendants recursively." },
        limit: { type: "number", description: "Maximum entries to return." },
        offset: { type: "number", description: "Number of entries to skip." },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a text file from Agent Drive by path (returns UTF-8 content, up to 5 MB). For larger or binary files use the REST download: GET /api/public/v1/files/:id/preview.",
    requiredScope: "read:drive",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write a UTF-8 text file to Agent Drive by path (max 5 MB). Text only — for binary files (PDF, images) or larger uploads use the REST presigned flow: POST /api/public/v1/files/upload -> PUT the bytes -> POST /files/upload/complete.",
    requiredScope: "write:drive",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        content_type: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "search_files",
    description: "Search Agent Drive files and folders by name or path.",
    requiredScope: "read:drive",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_share",
    description: "Create a share link for a file path or folder path.",
    requiredScope: "share:create",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        folder_path: { type: "string" },
        password: { type: "string" },
        max_downloads: { type: "number" },
        expires_in: { type: "number", description: "Expiration in seconds." },
      },
    },
  },
  {
    name: "remember",
    description: "Save a memory (note, decision, fact) to Agent Drive. Pass a stable key to update the same memory later instead of creating a new one.",
    requiredScope: "write:memory",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory text. Max 8KB." },
        key: { type: "string", description: "Optional stable key (e.g. project:agent-drive:decisions) for upsert semantics." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags for filtering." },
        source: { type: "string", description: "Optional note about who/what wrote this memory." },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description: "Full-text search saved memories, best match first. Use before starting work to recover prior context.",
    requiredScope: "read:memory",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query." },
        limit: { type: "number", description: "Max results, default 10, max 100." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_memories",
    description: "List saved memories, most recently updated first.",
    requiredScope: "read:memory",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results, default 20, max 100." },
        offset: { type: "number", description: "Number of entries to skip." },
      },
    },
  },
  {
    name: "send_file",
    description: "Send a drive file directly to a peer contact's Drive inbox (signed with this Drive's identity). The owner must have added the contact first.",
    requiredScope: "share:create",
    inputSchema: {
      type: "object",
      properties: {
        contact: { type: "string", description: "Contact name (see the owner's contact list)." },
        path: { type: "string", description: "Drive path of the file to send. Max 5MB." },
        message: { type: "string", description: "Optional note delivered with the file." },
      },
      required: ["contact", "path"],
    },
  },
  {
    name: "forget",
    description: "Delete a saved memory by id or key.",
    requiredScope: "write:memory",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id or key to delete." },
      },
      required: ["id"],
    },
  },
  {
    name: "list_spaces",
    description: "List the Shared Spaces you can reach (spaces you created plus spaces you were invited into), with your role and item/member counts.",
    requiredScope: "read:drive",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_space",
    description: "List the items in a space as a flat, attributed list (each item shows who contributed it). You must be a member of the space.",
    requiredScope: "read:drive",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "Space id (from list_spaces)." },
        type: { type: "string", description: "Optional filter: file, folder, or memory." },
      },
      required: ["space"],
    },
  },
  {
    name: "add_to_space",
    description: "Contribute one of YOUR OWN resources to a space by reference (no copy). You must be a contributor+ in the space and must own the resource. Editors who later edit a shared file change your real file.",
    requiredScope: "write:drive",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "Space id." },
        type: { type: "string", description: "file, folder, or memory." },
        path: { type: "string", description: "Drive path of the file/folder to contribute (for type file|folder)." },
        memory_key: { type: "string", description: "Memory id or key to contribute (for type memory)." },
      },
      required: ["space", "type"],
    },
  },
  {
    name: "remove_from_space",
    description: "Remove an item reference from a space (never deletes the underlying file/memory). You may remove your own items; removing another member's item requires the editor role.",
    requiredScope: "write:drive",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "Space id." },
        item_id: { type: "string", description: "The space item id (from read_space)." },
      },
      required: ["space", "item_id"],
    },
  },
  {
    name: "create_space",
    description: "Create a new invite-only Shared Space. You become its creator and can invite members with manage_space_members.",
    requiredScope: "write:drive",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable space name." },
      },
      required: ["name"],
    },
  },
  {
    name: "manage_space_members",
    description: "Invite, re-role, or remove a member of a space by email. Creator only. Pass role (viewer|contributor|editor) to add/update, or remove:true to remove.",
    requiredScope: "write:drive",
    inputSchema: {
      type: "object",
      properties: {
        space: { type: "string", description: "Space id." },
        email: { type: "string", description: "Email of an existing user to invite/update/remove." },
        role: { type: "string", description: "viewer, contributor, or editor (to add or update)." },
        remove: { type: "boolean", description: "Set true to remove the member instead of adding/updating." },
      },
      required: ["space", "email"],
    },
  },
];

const SPACE_ITEM_TYPES: readonly SpaceItemType[] = ["file", "folder", "memory"];
const SPACE_MEMBER_ROLES = ["viewer", "contributor", "editor"] as const;
type SpaceMemberRole = (typeof SPACE_MEMBER_ROLES)[number];

/**
 * Spaces require a real user identity. The owner-bound AGENT_TOKEN resolves to the owner's
 * user id (unaffected). The legacy deployment-wide AGENT_TOKEN on an OWNER_EMAIL-unset
 * install has no principal (userId null) — it cannot act in the per-user space model, so it
 * is rejected here rather than silently attributed to a null owner.
 */
function requireUserId(ownerId: string | null): string {
  if (!ownerId) throw new Error("identity_required:spaces require an authenticated user identity (session or a user-bound bearer token)");
  return ownerId;
}

function requireSpaceItemType(input: Record<string, unknown>): SpaceItemType {
  const value = stringArg(input, "type")!;
  if (!(SPACE_ITEM_TYPES as readonly string[]).includes(value)) {
    throw new Error(`invalid_params:type must be one of ${SPACE_ITEM_TYPES.join(", ")}`);
  }
  return value as SpaceItemType;
}

function requireSpaceMemberRole(input: Record<string, unknown>): SpaceMemberRole {
  const value = stringArg(input, "role")!;
  if (!(SPACE_MEMBER_ROLES as readonly string[]).includes(value)) {
    throw new Error(`invalid_params:role must be one of ${SPACE_MEMBER_ROLES.join(", ")}`);
  }
  return value as SpaceMemberRole;
}

export function listMcpTools(scopes: readonly string[]) {
  return MCP_TOOLS
    .filter((tool) => hasScope(scopes, tool.requiredScope))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
}

export async function callMcpTool(db: AppDb, origin: string, scopes: readonly string[], name: string, input: Record<string, unknown>, ownerId: string | null = null): Promise<ToolResult> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`unknown_tool:${name}`);
  if (!hasScope(scopes, tool.requiredScope)) throw new Error(`invalid_scope:${tool.requiredScope}`);

  if (name === "list_files") {
    const path = normalizePath(typeof input.path === "string" ? input.path : "/");
    const recursive = input.recursive === true;
    const limit = Math.max(1, Math.min(200, Math.trunc(numberArg(input, "limit", 100))));
    const offset = Math.max(0, Math.trunc(numberArg(input, "offset", 0)));
    // If the caller has path scopes and `path` is fully outside them, reject —
    // they shouldn't even know whether anything is inside.
    if (!pathAllowed(scopes, path)) {
      // Allow listing the root only if it's an ancestor of one of the granted
      // prefixes (so the agent can navigate down to its scoped subtree).
      const grantedPrefixes = extractPathPrefixes(scopes);
      const allowAsAncestor = grantedPrefixes.some((prefix) => prefix.startsWith(`${path === "/" ? "" : path}/`));
      if (!allowAsAncestor) throw new Error(`invalid_scope:path:${path}`);
    }
    // Read-path union: own rows plus space-reachable files (design §Read-path change / MCP
    // equivalents). Reduces to the strict owner filter when the caller has no spaces.
    const readable = await fileReadableFilter(db, ownerId);
    const loadRows = async (pageLimit: number, pageOffset: number): Promise<Array<typeof files.$inferSelect>> => {
      if (recursive) {
        return path === "/"
          ? db.select().from(files).where(and(isNull(files.deletedAt), readable)).orderBy(asc(files.path)).limit(pageLimit).offset(pageOffset)
          : db.select().from(files).where(and(sql`${files.path} LIKE ${escapedDescendantPattern(path)} ESCAPE '\\'`, isNull(files.deletedAt), readable)).orderBy(asc(files.path)).limit(pageLimit).offset(pageOffset);
      }
      return db.select().from(files).where(and(eq(files.parentPath, path), isNull(files.deletedAt), readable)).orderBy(desc(files.isFolder), asc(files.name)).limit(pageLimit).offset(pageOffset);
    };

    const visible: Array<typeof files.$inferSelect> = [];
    let skippedVisible = 0;
    let rawOffset = 0;
    const rawPageSize = 200;
    while (visible.length < limit) {
      const rows = await loadRows(rawPageSize, rawOffset);
      for (const row of rows) {
        if (!pathAllowed(scopes, row.path)) continue;
        if (skippedVisible < offset) {
          skippedVisible += 1;
          continue;
        }
        visible.push(row);
        if (visible.length >= limit) break;
      }
      rawOffset += rawPageSize;
      if (rows.length < rawPageSize) break;
    }
    return textResult({ path, limit, offset, files: visible.map(toFileObject) });
  }

  if (name === "read_file") {
    const path = normalizePath(stringArg(input, "path")!);
    requirePathAllowed(scopes, path);
    // Read path: widen to space-reachable files. A space file lives in the contributor's path
    // namespace; `.limit(1)` may pick the caller's own row first on a rare cross-owner path
    // collision — acceptable in P1 (the space endpoints are the collision-free access path).
    const readable = await fileReadableFilter(db, ownerId);
    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.path, path), eq(files.isFolder, 0), isNull(files.deletedAt), readable))
      .limit(1);
    if (!file?.s3Uri) throw new Error("file_not_found");
    const { storage } = await import("edgespark");
    const parsed = storage.tryParseS3Uri(file.s3Uri);
    if (!parsed) throw new Error("file_not_found");
    // Guard on the REAL R2 object size (a HEAD, no body) BEFORE loading it into Worker
    // memory. The DB size can be stale if the object was re-PUT via a still-valid
    // presigned URL, so it is not a reliable memory-safety boundary.
    const meta = await storage.from(buckets.drive).head(parsed.path);
    if (meta && meta.size > MCP_READ_FILE_MAX_BYTES) {
      throw new Error(`file_too_large:file is ${meta.size} bytes; read_file returns text up to ${MCP_READ_FILE_MAX_BYTES} bytes — use the REST download (GET /api/public/v1/files/:id/preview) for larger or binary files`);
    }
    const object = await storage.from(buckets.drive).get(parsed.path);
    if (!object) throw new Error("file_not_found");
    const text = new TextDecoder().decode(object.body);
    return textResult({ path: file.path, content: text, size: file.size, contentType: file.contentType });
  }

  if (name === "write_file") {
    const path = normalizePath(stringArg(input, "path")!);
    requirePathAllowed(scopes, path);
    const content = rawStringArg(input, "content")!;
    const contentType = stringArg(input, "content_type", false) ?? "text/plain";
    const overwrite = input.overwrite !== false;
    const parentPath = parentOfPath(path);
    const filename = normalizeName(path.split("/").pop());
    const bytes = new TextEncoder().encode(content);
    const { storage } = await import("edgespark");

    // Resolve the write target BEFORE mutating anything. Prefer the caller's OWN row at this
    // path — the #30 owner-scoped behavior, unchanged for a caller writing their own file.
    const [ownRow] = await db
      .select()
      .from(files)
      .where(and(eq(files.path, path), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
      .limit(1);

    // Shared Spaces write relaxation (design D1 / Task 6): if the caller does NOT own a file
    // here but reaches a cross-owner file at this path through a space, an editor+ overwrites
    // the CONTRIBUTOR's real file (live-reference edit); a contributor/viewer is refused with
    // `space_forbidden` rather than silently forking a shadow copy into their own namespace.
    let existing = ownRow;
    let editingViaSpace = false;
    if (!ownRow && ownerId) {
      const readable = await fileReadableFilter(db, ownerId);
      const [spaceFile] = await db
        .select()
        .from(files)
        .where(and(eq(files.path, path), eq(files.isFolder, 0), isNull(files.deletedAt), readable))
        .limit(1);
      if (spaceFile && spaceFile.ownerId !== ownerId) {
        if (!(await canEditFileViaSpace(db, ownerId, spaceFile.id))) {
          throw new Error("space_forbidden:editing another member's file in a space requires the editor role");
        }
        existing = spaceFile;
        editingViaSpace = true;
      }
    }

    if (existing?.isFolder === 1) throw new Error("path_conflict:target is a folder");
    if (existing && !overwrite) throw new Error("path_conflict:file already exists");

    // The caller's folder chain + trash purge apply only when writing into the caller's own
    // namespace. Editing a contributor's existing file must not scaffold caller-owned folders
    // or touch the contributor's trash.
    if (!editingViaSpace) {
      await ensureFolderChain(db, parentPath, ownerId);
      await purgeConflictingTrashAtPath(db, storage, path);
    }

    if (bytes.byteLength > MCP_WRITE_FILE_MAX_BYTES) {
      throw new Error(`file_too_large:write_file content is ${bytes.byteLength} bytes; the limit is ${MCP_WRITE_FILE_MAX_BYTES} bytes (use REST presigned upload for larger/binary files)`);
    }
    const quotaCheck = await checkTotalQuota(db, bytes.byteLength - (existing?.size ?? 0));
    if (!quotaCheck.ok) throw new Error(`${quotaCheck.code}:${quotaCheck.message}`);

    const fileId = existing?.id ?? nanoid();
    // Overwrite an existing file at its STORED key rather than re-deriving one from
    // the current name: after a rename the two differ, and writing to a fresh key
    // would strand the old object forever — the orphan reconciler keys off the file
    // id, which is still live, so it would never reap it.
    const existingKey = existing?.s3Uri ? storage.tryParseS3Uri(existing.s3Uri)?.path : undefined;
    const objectPath = existingKey ?? objectPathForWrite(fileId, filename);
    await storage.from(buckets.drive).put(objectPath, bytes, { contentType });
    const timestamp = nowIso();
    const values = {
      id: fileId,
      name: filename,
      path,
      parentPath,
      isFolder: 0,
      size: bytes.byteLength,
      contentType,
      s3Uri: storage.createS3Uri(buckets.drive, objectPath),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const [saved] = existing
      ? await db.update(files).set(values).where(eq(files.id, existing.id)).returning()
      : await db.insert(files).values({ ...values, ownerId }).returning();
    return textResult({ file: saved ? toFileObject(saved) : values });
  }

  if (name === "search_files") {
    const query = stringArg(input, "query")!;
    const limit = Math.max(1, Math.min(100, Math.trunc(numberArg(input, "limit", 50))));
    if (query.length < 2) return textResult({ query, files: [] });
    const pattern = `%${escapeLikeQuery(query)}%`;
    const readable = await fileReadableFilter(db, ownerId);
    const rows = await db
      .select()
      .from(files)
      .where(and(
        or(sql`${files.name} LIKE ${pattern} ESCAPE '\\'`, sql`${files.path} LIKE ${pattern} ESCAPE '\\'`),
        isNull(files.deletedAt),
        readable
      ))
      .orderBy(desc(files.isFolder), asc(files.name))
      .limit(limit);
    const visible = rows.filter((row) => pathAllowed(scopes, row.path));
    return textResult({ query, files: visible.map(toFileObject) });
  }

  if (name === "create_share") {
    const filePath = stringArg(input, "file_path", false);
    const folderPathInput = stringArg(input, "folder_path", false);
    if ((filePath ? 1 : 0) + (folderPathInput ? 1 : 0) !== 1) throw new Error("invalid_params:exactly one of file_path or folder_path is required");
    const password = stringArg(input, "password", false);
    const maxDownloads = input.max_downloads == null ? null : Math.trunc(numberArg(input, "max_downloads", 0));
    const expiresIn = input.expires_in == null ? null : Math.trunc(numberArg(input, "expires_in", 0));
    if (maxDownloads !== null && maxDownloads <= 0) throw new Error("invalid_params:max_downloads must be positive");
    if (expiresIn !== null && expiresIn <= 0) throw new Error("invalid_params:expires_in must be positive");

    if (filePath) requirePathAllowed(scopes, normalizePath(filePath));
    if (folderPathInput) requirePathAllowed(scopes, normalizePath(folderPathInput));

    let fileId: string | null = null;
    let folderPath: string | null = null;
    if (filePath) {
      const [file] = await db
        .select()
        .from(files)
        .where(and(eq(files.path, normalizePath(filePath)), eq(files.isFolder, 0), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
        .limit(1);
      if (!file) throw new Error("file_not_found");
      fileId = file.id;
    } else if (folderPathInput) {
      folderPath = normalizePath(folderPathInput);
      if (folderPath !== "/") {
        const [folder] = await db
          .select()
          .from(files)
          .where(and(eq(files.path, folderPath), eq(files.isFolder, 1), isNull(files.deletedAt), ownerId ? eq(files.ownerId, ownerId) : undefined))
          .limit(1);
        if (!folder) throw new Error("folder_not_found");
      }
    }

    const [share] = await db.insert(shares).values({
      id: nanoid(8),
      fileId,
      folderPath,
      passwordHash: password ? await hashPassword(password) : null,
      passwordVersion: 1,
      maxDownloads,
      downloadCount: 0,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      createdAt: nowIso(),
      ownerId,
    }).returning();
    return textResult({ shareId: share.id, shareUrl: `${origin}/s/${share.id}`, guideUrl: `${origin}/api/public/guide`, hasPassword: Boolean(password), maxDownloads, expiresAt: share.expiresAt });
  }

  if (name === "remember") {
    const { memory, created } = await rememberMemory(db, {
      content: rawStringArg(input, "content") ?? "",
      key: stringArg(input, "key", false),
      tags: input.tags,
      source: stringArg(input, "source", false),
      ownerId,
    });
    return textResult({ memory, created });
  }

  if (name === "recall") {
    const query = stringArg(input, "query") ?? "";
    const limit = numberArg(input, "limit", 10);
    // Read-path union: own memories + memory ids reachable via spaces (design §Read-path
    // change / MCP equivalents). Reduces to the strict owner filter when the caller has no
    // spaces, so a non-member sees exactly the #30-isolated result.
    const readable = await memoryReadableFilter(db, ownerId);
    const results = await recallMemories(db, query, limit, ownerId, readable);
    return textResult({ query, count: results.length, memories: results });
  }

  if (name === "list_memories") {
    const limit = numberArg(input, "limit", 20);
    const offset = Math.max(0, Math.trunc(numberArg(input, "offset", 0)));
    const readable = await memoryReadableFilter(db, ownerId);
    const results = await listMemories(db, limit, offset, ownerId, readable);
    return textResult({ count: results.length, offset, memories: results });
  }

  if (name === "send_file") {
    const contactName = stringArg(input, "contact") ?? "";
    const path = normalizePath(stringArg(input, "path") ?? "");
    requirePathAllowed(scopes, path);
    const message = stringArg(input, "message", false);
    const contact = await getContactByName(db, contactName, ownerId);
    if (!contact) throw new Error("contact_not_found");
    const { storage } = await import("edgespark");
    const result = await sendFileToContact(db, storage, contact, path, message, origin);
    return textResult(result);
  }

  if (name === "forget") {
    const idOrKey = stringArg(input, "id") ?? "";
    const forgotten = await forgetMemory(db, idOrKey, ownerId);
    if (!forgotten) throw new Error("memory_not_found");
    return textResult({ forgotten });
  }

  if (name === "list_spaces") {
    const callerId = requireUserId(ownerId);
    const spaceIds = await userSpaceIds(db, callerId);
    if (spaceIds.length === 0) return textResult({ spaces: [] });
    const rows = await db.select().from(spaces).where(inArray(spaces.id, spaceIds));
    const result = await Promise.all(
      rows.map(async (space) => {
        // Role is never null: space.id came from userSpaceIds(callerId).
        const role = (await resolveSpaceRole(db, space.id, callerId))!;
        const counts = await spaceCounts(db, space.id);
        return toSpaceSummary(space, role, counts);
      })
    );
    return textResult({ spaces: result });
  }

  if (name === "read_space") {
    const callerId = requireUserId(ownerId);
    const spaceId = stringArg(input, "space")!;
    const itemType = input.type == null ? undefined : requireSpaceItemType(input);

    // Non-member (or missing space) → space_not_found, never leaking that the id is real —
    // mirrors REST GET /spaces/:id (404, not the 403 the creator-only mutations use).
    const role = await resolveSpaceRole(db, spaceId, callerId);
    if (role === null) throw new Error("space_not_found:space not found");

    const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
    const counts = await spaceCounts(db, spaceId);
    const rows = await db
      .select()
      .from(spaceItems)
      .where(and(eq(spaceItems.spaceId, spaceId), itemType ? eq(spaceItems.itemType, itemType) : undefined))
      .orderBy(desc(spaceItems.addedAt));
    const items = await toDisplayItems(db, rows);
    return textResult({ space: toSpaceSummary(space, role, counts), items });
  }

  if (name === "add_to_space") {
    const callerId = requireUserId(ownerId);
    const spaceId = stringArg(input, "space")!;
    const itemType = requireSpaceItemType(input);
    const ref = itemType === "memory" ? stringArg(input, "memory_key")! : stringArg(input, "path")!;

    // contributor+ to add; ownership of the resource is re-verified by resolveOwnedContributionRef.
    await assertSpaceRole(db, spaceId, callerId, "contributor");
    const itemRef = await resolveOwnedContributionRef(db, itemType, ref, callerId);

    await db
      .insert(spaceItems)
      .values({ id: nanoid(), spaceId, itemType, itemRef, contributedBy: callerId, addedAt: nowIso() })
      .onConflictDoNothing({ target: [spaceItems.spaceId, spaceItems.itemType, spaceItems.itemRef] });
    // Idempotent contribute: re-select rather than trust .returning() after onConflictDoNothing.
    const [item] = await db
      .select()
      .from(spaceItems)
      .where(and(eq(spaceItems.spaceId, spaceId), eq(spaceItems.itemType, itemType), eq(spaceItems.itemRef, itemRef)))
      .limit(1);
    if (!item) throw new Error("internal_error:space item was not created");
    const [display] = await toDisplayItems(db, [item]);
    return textResult({ item: display });
  }

  if (name === "remove_from_space") {
    const callerId = requireUserId(ownerId);
    const spaceId = stringArg(input, "space")!;
    const itemId = stringArg(input, "item_id")!;

    // contributor+ required before any lookup; a viewer/non-member is refused here.
    await assertSpaceRole(db, spaceId, callerId, "contributor");
    const [item] = await db
      .select()
      .from(spaceItems)
      .where(and(eq(spaceItems.id, itemId), eq(spaceItems.spaceId, spaceId)))
      .limit(1);
    if (!item) throw new Error("item_not_found:space item not found");
    // A contributor may remove only their OWN item; removing anyone else's needs editor+.
    if (item.contributedBy !== callerId) {
      await assertSpaceRole(db, spaceId, callerId, "editor");
    }
    await db.delete(spaceItems).where(eq(spaceItems.id, itemId));
    return textResult({ removed: true, id: itemId });
  }

  if (name === "create_space") {
    const callerId = requireUserId(ownerId);
    const rawName = stringArg(input, "name")!;
    const spaceName = rawName.length > 200 ? rawName.slice(0, 200) : rawName;
    const [space] = await db
      .insert(spaces)
      .values({ id: nanoid(), name: spaceName, creatorId: callerId, visibility: "invite", createdAt: nowIso() })
      .returning();
    if (!space) throw new Error("internal_error:space was not created");
    return textResult({ space: toSpaceSummary(space, "creator", { memberCount: 1, itemCount: 0 }) });
  }

  if (name === "manage_space_members") {
    const callerId = requireUserId(ownerId);
    const spaceId = stringArg(input, "space")!;
    const email = stringArg(input, "email")!;
    const remove = input.remove === true;

    // Creator-only membership management (design §Security spine #3).
    await assertSpaceRole(db, spaceId, callerId, "creator");
    const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
    if (!space) throw new Error("space_not_found:space not found");
    const memberUserId = await resolveUserIdByEmail(db, email);
    if (memberUserId === space.creatorId) {
      throw new Error("invalid_params:the space creator cannot be added, changed, or removed as a member");
    }

    if (remove) {
      const deleted = await db
        .delete(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, memberUserId)))
        .returning({ userId: spaceMembers.userId });
      if (deleted.length === 0) throw new Error("member_not_found:that user is not a member of this space");
      // Retract the removed member's contributions too (parity with REST DELETE members) —
      // a removed member's shared resources should stop being reachable by the space.
      await db.delete(spaceItems).where(and(eq(spaceItems.spaceId, spaceId), eq(spaceItems.contributedBy, memberUserId)));
      return textResult({ removed: true, userId: memberUserId });
    }

    const role = requireSpaceMemberRole(input);
    const addedAt = nowIso();
    await db
      .insert(spaceMembers)
      .values({ spaceId, userId: memberUserId, role, addedBy: callerId, addedAt })
      .onConflictDoUpdate({
        target: [spaceMembers.spaceId, spaceMembers.userId],
        set: { role, addedBy: callerId, addedAt },
      });
    return textResult({ member: { userId: memberUserId, email, role, addedBy: callerId, addedAt } });
  }

  throw new Error(`unknown_tool:${name}`);
}
