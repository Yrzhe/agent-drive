import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { buckets, files, shares } from "@defs";

import { hashPassword } from "./crypto";
import { ensureFolderChain, nowIso, toFileObject } from "./files";
import { descendantPattern, joinPath, normalizeName, normalizePath, parentOfPath } from "./paths";
import { hasScope, type McpScope } from "./mcp-scopes";
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
    description: "Write a text file to Agent Drive by path.",
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
    const rows = recursive
      ? path === "/"
        ? await db.select().from(files).orderBy(asc(files.path)).limit(limit)
        : await db.select().from(files).where(like(files.path, descendantPattern(path))).orderBy(asc(files.path)).limit(limit)
      : await db.select().from(files).where(eq(files.parentPath, path)).orderBy(desc(files.isFolder), asc(files.name)).limit(limit);
    return textResult({ path, files: rows.map(toFileObject) });
  }

  if (name === "read_file") {
    const path = normalizePath(stringArg(input, "path")!);
    const [file] = await db.select().from(files).where(and(eq(files.path, path), eq(files.isFolder, 0))).limit(1);
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
    const content = rawStringArg(input, "content")!;
    const contentType = stringArg(input, "content_type", false) ?? "text/plain";
    const overwrite = input.overwrite !== false;
    const parentPath = parentOfPath(path);
    const filename = normalizeName(path.split("/").pop());
    const bytes = new TextEncoder().encode(content);
    const { storage } = await import("edgespark");
    await ensureFolderChain(db, parentPath);

    const [existing] = await db.select().from(files).where(eq(files.path, path)).limit(1);
    if (existing?.isFolder === 1) throw new Error("path_conflict:target is a folder");
    if (existing && !overwrite) throw new Error("path_conflict:file already exists");

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
      .where(or(sql`${files.name} LIKE ${pattern} ESCAPE '\\'`, sql`${files.path} LIKE ${pattern} ESCAPE '\\'`))
      .orderBy(desc(files.isFolder), asc(files.name))
      .limit(limit);
    return textResult({ query, files: rows.map(toFileObject) });
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

    let fileId: string | null = null;
    let folderPath: string | null = null;
    if (filePath) {
      const [file] = await db.select().from(files).where(and(eq(files.path, normalizePath(filePath)), eq(files.isFolder, 0))).limit(1);
      if (!file) throw new Error("file_not_found");
      fileId = file.id;
    } else if (folderPathInput) {
      folderPath = normalizePath(folderPathInput);
      const [folder] = await db.select().from(files).where(and(eq(files.path, folderPath), eq(files.isFolder, 1))).limit(1);
      if (!folder) throw new Error("folder_not_found");
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
    return textResult({ shareId: share.id, shareUrl: `${origin}/s/${share.id}`, hasPassword: Boolean(password), maxDownloads, expiresAt: share.expiresAt });
  }

  throw new Error(`unknown_tool:${name}`);
}
