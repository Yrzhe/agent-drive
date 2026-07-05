import { desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { memories } from "@defs";

import { nowIso } from "./files";
import type { AppDb } from "../types";

export type MemoryRow = typeof memories.$inferSelect;

export const MEMORY_CONTENT_MAX_BYTES = 8 * 1024;
export const MEMORY_LIST_MAX_LIMIT = 100;

export interface MemoryObject {
  id: string;
  key: string | null;
  content: string;
  tags: string[];
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toMemoryObject(row: MemoryRow): MemoryObject {
  return {
    id: row.id,
    key: row.key,
    content: row.content,
    tags: parseTags(row.tags),
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export const MEMORY_MAX_TAGS = 32;
export const MEMORY_TAG_MAX_CHARS = 64;

export function serializeTags(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  const cleaned = [
    ...new Set(
      tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim().slice(0, MEMORY_TAG_MAX_CHARS))
        .filter(Boolean)
    ),
  ].slice(0, MEMORY_MAX_TAGS);
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
}

/**
 * Build a safe FTS5 MATCH expression from a free-form query: each whitespace
 * token becomes a quoted phrase with a trailing prefix wildcard, joined by
 * implicit AND. Quoting neutralizes FTS5 operators so user input can never
 * produce a syntax error.
 */
export function buildFtsMatchQuery(query: string): string {
  const tokens = query.split(/\s+/u).map((token) => token.replace(/"/g, "").trim()).filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token.replace(/"/g, '""')}" *`).join(" ");
}

export function normalizeMemoryKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed.length > 256) throw new Error("invalid_params:key must be at most 256 characters");
  return trimmed;
}

export function validateMemoryContent(content: unknown): string {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("invalid_params:content is required");
  }
  if (new TextEncoder().encode(content).byteLength > MEMORY_CONTENT_MAX_BYTES) {
    throw new Error(`invalid_params:content must be at most ${MEMORY_CONTENT_MAX_BYTES} bytes`);
  }
  return content;
}

export interface RememberInput {
  content: string;
  key?: string | null;
  tags?: unknown;
  source?: string | null;
}

/** Insert a memory, or update in place when `key` matches an existing row. */
export async function rememberMemory(db: AppDb, input: RememberInput): Promise<{ memory: MemoryObject; created: boolean }> {
  const content = validateMemoryContent(input.content);
  const key = normalizeMemoryKey(input.key);
  const tags = serializeTags(input.tags);
  const source = typeof input.source === "string" && input.source.trim() ? input.source.trim().slice(0, 128) : null;
  const timestamp = nowIso();

  const updateByKey = async (): Promise<MemoryObject | null> => {
    if (!key) return null;
    const [updated] = await db
      .update(memories)
      .set({ content, tags, source, updatedAt: timestamp })
      .where(eq(memories.key, key))
      .returning();
    return updated ? toMemoryObject(updated) : null;
  };

  const updated = await updateByKey();
  if (updated) return { memory: updated, created: false };

  try {
    const [created] = await db
      .insert(memories)
      .values({ id: nanoid(), key, content, tags, source, createdAt: timestamp, updatedAt: timestamp })
      .returning();
    return { memory: toMemoryObject(created), created: true };
  } catch (error) {
    // Concurrent remember with the same new key: the loser of the unique
    // race retries as an update instead of surfacing a 500.
    const message = (error as { message?: string } | null)?.message?.toLowerCase() ?? "";
    if (key && message.includes("unique constraint failed") && message.includes("memories.key")) {
      const retried = await updateByKey();
      if (retried) return { memory: retried, created: false };
    }
    throw error;
  }
}

/** Full-text search via the memories_fts FTS5 index, best match first. */
export async function recallMemories(db: AppDb, query: string, limit: number): Promise<MemoryObject[]> {
  const match = buildFtsMatchQuery(query);
  if (!match) throw new Error("invalid_params:query is required");
  const boundedLimit = Math.max(1, Math.min(MEMORY_LIST_MAX_LIMIT, Math.trunc(limit)));
  const rows = await db.all<Record<string, unknown>>(sql`
    SELECT m.* FROM ${memories} m
    JOIN memories_fts f ON m.rowid = f.rowid
    WHERE memories_fts MATCH ${match}
    ORDER BY f.rank
    LIMIT ${boundedLimit}
  `);
  return rows.map((row) => toMemoryObject(mapRawRow(row)));
}

// db.all returns snake_case column names; map them back to the drizzle shape.
function mapRawRow(row: Record<string, unknown>): MemoryRow {
  return {
    id: String(row.id),
    key: (row.key as string | null) ?? null,
    content: String(row.content),
    tags: (row.tags as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? ""),
  };
}

export async function listMemories(db: AppDb, limit: number, offset: number): Promise<MemoryObject[]> {
  const boundedLimit = Math.max(1, Math.min(MEMORY_LIST_MAX_LIMIT, Math.trunc(limit)));
  const boundedOffset = Math.max(0, Math.trunc(offset));
  const rows = await db.select().from(memories).orderBy(desc(memories.updatedAt)).limit(boundedLimit).offset(boundedOffset);
  return rows.map(toMemoryObject);
}

export async function getMemory(db: AppDb, idOrKey: string): Promise<MemoryRow | null> {
  // id wins over key so a user-chosen key can never shadow another row's id.
  const [byId] = await db.select().from(memories).where(eq(memories.id, idOrKey)).limit(1);
  if (byId) return byId;
  const [byKey] = await db.select().from(memories).where(eq(memories.key, idOrKey)).limit(1);
  return byKey ?? null;
}

export async function forgetMemory(db: AppDb, idOrKey: string): Promise<MemoryObject | null> {
  const existing = await getMemory(db, idOrKey);
  if (!existing) return null;
  await db.delete(memories).where(eq(memories.id, existing.id));
  return toMemoryObject(existing);
}
