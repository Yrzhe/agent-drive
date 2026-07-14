import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { buckets, files, shares } from "@defs";

import { hashPassword } from "./crypto";
import { ensureFolderChain, nowIso, toFileObject } from "./files";
import { forgetMemory, listMemories, recallMemories, rememberMemory } from "./memory";
import { getContactByName, sendFileToContact } from "./peering";
import { escapedDescendantPattern, joinPath, normalizeName, normalizePath, parentOfPath } from "./paths";
import { extractPathPrefixes, hasScope, pathAllowed, requirePathAllowed, type McpScope } from "./mcp-scopes";
import { checkTotalQuota, MCP_WRITE_FILE_MAX_BYTES } from "./quota";
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
  return `${fileId}/${encodeURIComponent(filename)}`;
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
    description: "Read a text file from Agent Drive by path.",
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
];

export function listMcpTools(scopes: readonly string[]) {
  return MCP_TOOLS
    .filter((tool) => hasScope(scopes, tool.requiredScope))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
}

export async function callMcpTool(db: AppDb, origin: string, scopes: readonly string[], name: string, input: Record<string, unknown>): Promise<ToolResult> {
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
    const loadRows = async (pageLimit: number, pageOffset: number): Promise<Array<typeof files.$inferSelect>> => {
      if (recursive) {
        return path === "/"
          ? db.select().from(files).where(isNull(files.deletedAt)).orderBy(asc(files.path)).limit(pageLimit).offset(pageOffset)
          : db.select().from(files).where(and(sql`${files.path} LIKE ${escapedDescendantPattern(path)} ESCAPE '\\'`, isNull(files.deletedAt))).orderBy(asc(files.path)).limit(pageLimit).offset(pageOffset);
      }
      return db.select().from(files).where(and(eq(files.parentPath, path), isNull(files.deletedAt))).orderBy(desc(files.isFolder), asc(files.name)).limit(pageLimit).offset(pageOffset);
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
    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.path, path), eq(files.isFolder, 0), isNull(files.deletedAt)))
      .limit(1);
    if (!file?.s3Uri) throw new Error("file_not_found");
    const { storage } = await import("edgespark");
    const parsed = storage.tryParseS3Uri(file.s3Uri);
    if (!parsed) throw new Error("file_not_found");
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
    await ensureFolderChain(db, parentPath);
    await purgeConflictingTrashAtPath(db, storage, path);

    const [existing] = await db
      .select()
      .from(files)
      .where(and(eq(files.path, path), isNull(files.deletedAt)))
      .limit(1);
    if (existing?.isFolder === 1) throw new Error("path_conflict:target is a folder");
    if (existing && !overwrite) throw new Error("path_conflict:file already exists");

    if (bytes.byteLength > MCP_WRITE_FILE_MAX_BYTES) {
      throw new Error(`file_too_large:write_file content is ${bytes.byteLength} bytes; the limit is ${MCP_WRITE_FILE_MAX_BYTES} bytes (use REST presigned upload for larger/binary files)`);
    }
    const quotaCheck = await checkTotalQuota(db, bytes.byteLength - (existing?.size ?? 0));
    if (!quotaCheck.ok) throw new Error(`${quotaCheck.code}:${quotaCheck.message}`);

    const fileId = existing?.id ?? nanoid();
    const objectPath = objectPathForWrite(fileId, filename);
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
      : await db.insert(files).values(values).returning();
    return textResult({ file: saved ? toFileObject(saved) : values });
  }

  if (name === "search_files") {
    const query = stringArg(input, "query")!;
    const limit = Math.max(1, Math.min(100, Math.trunc(numberArg(input, "limit", 50))));
    if (query.length < 2) return textResult({ query, files: [] });
    const pattern = `%${escapeLikeQuery(query)}%`;
    const rows = await db
      .select()
      .from(files)
      .where(and(
        or(sql`${files.name} LIKE ${pattern} ESCAPE '\\'`, sql`${files.path} LIKE ${pattern} ESCAPE '\\'`),
        isNull(files.deletedAt)
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
        .where(and(eq(files.path, normalizePath(filePath)), eq(files.isFolder, 0), isNull(files.deletedAt)))
        .limit(1);
      if (!file) throw new Error("file_not_found");
      fileId = file.id;
    } else if (folderPathInput) {
      folderPath = normalizePath(folderPathInput);
      if (folderPath !== "/") {
        const [folder] = await db
          .select()
          .from(files)
          .where(and(eq(files.path, folderPath), eq(files.isFolder, 1), isNull(files.deletedAt)))
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
    }).returning();
    return textResult({ shareId: share.id, shareUrl: `${origin}/s/${share.id}`, guideUrl: `${origin}/api/public/guide`, hasPassword: Boolean(password), maxDownloads, expiresAt: share.expiresAt });
  }

  if (name === "remember") {
    const { memory, created } = await rememberMemory(db, {
      content: rawStringArg(input, "content") ?? "",
      key: stringArg(input, "key", false),
      tags: input.tags,
      source: stringArg(input, "source", false),
    });
    return textResult({ memory, created });
  }

  if (name === "recall") {
    const query = stringArg(input, "query") ?? "";
    const limit = numberArg(input, "limit", 10);
    const results = await recallMemories(db, query, limit);
    return textResult({ query, count: results.length, memories: results });
  }

  if (name === "list_memories") {
    const limit = numberArg(input, "limit", 20);
    const offset = Math.max(0, Math.trunc(numberArg(input, "offset", 0)));
    const results = await listMemories(db, limit, offset);
    return textResult({ count: results.length, offset, memories: results });
  }

  if (name === "send_file") {
    const contactName = stringArg(input, "contact") ?? "";
    const path = normalizePath(stringArg(input, "path") ?? "");
    requirePathAllowed(scopes, path);
    const message = stringArg(input, "message", false);
    const contact = await getContactByName(db, contactName);
    if (!contact) throw new Error("contact_not_found");
    const { storage } = await import("edgespark");
    const result = await sendFileToContact(db, storage, contact, path, message, origin);
    return textResult(result);
  }

  if (name === "forget") {
    const idOrKey = stringArg(input, "id") ?? "";
    const forgotten = await forgetMemory(db, idOrKey);
    if (!forgotten) throw new Error("memory_not_found");
    return textResult({ forgotten });
  }

  throw new Error(`unknown_tool:${name}`);
}
