import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { buckets, bundleVersions, contacts, drizzleSchema, files, memories, shares } from "@defs";

import { driveObjectKey } from "../../src/lib/object-keys";

interface TestUser {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
  isAnonymous: boolean;
  createdAt: Date;
}

interface StoredObject {
  body: ArrayBuffer;
  metadata: {
    size: number;
    contentType?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    cacheControl?: string;
  };
  uploadedAt: Date;
}

function cloneArrayBuffer(input: ArrayBuffer): ArrayBuffer {
  return input.slice(0);
}

function toArrayBuffer(input: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (input instanceof ArrayBuffer) return cloneArrayBuffer(input);
  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
}

function bucketName(bucket: { bucket_name: string } | string): string {
  return typeof bucket === "string" ? bucket : bucket.bucket_name;
}

class InMemoryBucket {
  constructor(private readonly owner: InMemoryStorage, private readonly name: string) {}

  private key(pathname: string): string {
    return `${this.name}/${pathname}`;
  }

  async put(
    pathname: string,
    body: ArrayBuffer | ArrayBufferView,
    options: {
      contentType?: string;
      contentDisposition?: string;
      contentEncoding?: string;
      cacheControl?: string;
    } = {}
  ): Promise<void> {
    const bytes = toArrayBuffer(body);
    this.owner.objects.set(this.key(pathname), {
      body: bytes,
      metadata: {
        size: bytes.byteLength,
        contentType: options.contentType,
        contentDisposition: options.contentDisposition,
        contentEncoding: options.contentEncoding,
        cacheControl: options.cacheControl,
      },
      uploadedAt: new Date(),
    });
  }

  async get(pathname: string): Promise<{ body: ArrayBuffer; metadata: StoredObject["metadata"] } | null> {
    const object = this.owner.objects.get(this.key(pathname));
    if (!object) return null;
    return { body: cloneArrayBuffer(object.body), metadata: { ...object.metadata } };
  }

  async head(pathname: string): Promise<StoredObject["metadata"] | null> {
    const object = this.owner.objects.get(this.key(pathname));
    return object ? { ...object.metadata } : null;
  }

  async list(options: { limit?: number; prefix?: string; cursor?: string; delimiter?: string } = {}) {
    const prefix = options.prefix ?? "";
    const limit = Math.min(options.limit ?? 1000, 1000);
    const all = [...this.owner.objects.entries()]
      .filter(([key]) => key.startsWith(`${this.name}/${prefix}`))
      .map(([key, object]) => ({ path: key.slice(this.name.length + 1), size: object.metadata.size, uploadedAt: object.uploadedAt }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const start = options.cursor ? Number(options.cursor) : 0;
    const page = all.slice(start, start + limit);
    return {
      files: page,
      hasMore: start + limit < all.length,
      cursor: start + limit < all.length ? String(start + limit) : undefined,
      delimitedPrefixes: [],
    };
  }

  async delete(paths: string | readonly string[]): Promise<void> {
    for (const pathname of Array.isArray(paths) ? paths : [paths]) {
      this.owner.objects.delete(this.key(pathname));
    }
  }

  // The presign family embeds `pathname` in the URL VERBATIM — it applies no
  // encoding of its own (verified against production: an already-encoded path
  // came back as `%E6…`, not `%25E6…`). S3/R2 then URL-decodes the key once when
  // it serves the request, so the effective key is `decodeURIComponent(pathname)`.
  // The binding family (put/get/head/delete) treats `pathname` as a literal key.
  // Modelling that split is the whole point: an encoder-agnostic mock cannot
  // reproduce the raw-vs-encoded key bug at all.
  async createPresignedPutUrl(
    pathname: string,
    expiresInSecs = 3600,
    options: { contentType?: string } = {}
  ): Promise<{ uploadUrl: string; requiredHeaders: Record<string, string>; expiresAt: Date }> {
    const requiredHeaders = options.contentType ? { "content-type": options.contentType } : {};
    return {
      uploadUrl: `memory://put/${this.name}/${pathname}`,
      requiredHeaders,
      expiresAt: new Date(Date.now() + expiresInSecs * 1000),
    };
  }

  async createPresignedGetUrl(
    pathname: string,
    expiresInSecs = 3600
  ): Promise<{ downloadUrl: string; expiresAt: Date }> {
    return {
      downloadUrl: `memory://get/${this.name}/${pathname}`,
      expiresAt: new Date(Date.now() + expiresInSecs * 1000),
    };
  }
}

/** Split a `memory://{op}/{bucket}/{verbatimPath}` URL the mock handed out. */
function parsePresignedUrl(url: string): { op: string; bucket: string; key: string } {
  const match = /^memory:\/\/(put|get)\/([^/]+)\/(.*)$/su.exec(url);
  if (!match) throw new Error(`not a presigned mock url: ${url}`);
  // S3/R2 decodes the key once when serving the presigned request.
  return { op: match[1], bucket: match[2], key: decodeURIComponent(match[3]) };
}

/**
 * Simulate the client's direct PUT to a presigned URL. The object lands at the
 * key S3 resolves — `decodeURIComponent(path-in-url)` — NOT at the string we
 * handed the presign call.
 */
export async function putViaPresignedUrl(
  uploadUrl: string,
  body: string | Uint8Array,
  contentType = "application/octet-stream"
): Promise<void> {
  const { bucket, key } = parsePresignedUrl(uploadUrl);
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  await runtime.storage.from(bucket).put(key, bytes, { contentType });
}

/** Simulate a client GET against a presigned URL; null when S3 would 404. */
export async function getViaPresignedUrl(downloadUrl: string): Promise<Uint8Array | null> {
  const { bucket, key } = parsePresignedUrl(downloadUrl);
  const object = await runtime.storage.from(bucket).get(key);
  return object ? new Uint8Array(object.body) : null;
}

export class InMemoryStorage {
  readonly objects = new Map<string, StoredObject>();

  from(bucket: { bucket_name: string } | string): InMemoryBucket {
    return new InMemoryBucket(this, bucketName(bucket));
  }

  createS3Uri(bucket: { bucket_name: string } | string, pathname: string): `s3://${string}/${string}` {
    return `s3://${bucketName(bucket)}/${pathname}`;
  }

  isS3Uri(value: string): value is `s3://${string}/${string}` {
    return this.tryParseS3Uri(value) !== null;
  }

  parseS3Uri(s3Uri: string): { bucket: { bucket_name: string; description: string }; path: string } {
    const parsed = this.tryParseS3Uri(s3Uri);
    if (!parsed) throw new Error(`Invalid S3 URI: ${s3Uri}`);
    return parsed;
  }

  tryParseS3Uri(s3Uri: string): { bucket: { bucket_name: string; description: string }; path: string } | null {
    if (!s3Uri.startsWith("s3://")) return null;
    const rest = s3Uri.slice("s3://".length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) return null;
    return {
      bucket: { bucket_name: rest.slice(0, slash), description: "test bucket" },
      path: rest.slice(slash + 1),
    };
  }
}

interface RuntimeState {
  sqlite: Database.Database | null;
  db: any;
  storage: InMemoryStorage;
  vars: Map<string, string>;
  secrets: Map<string, string>;
  auth: { authenticated: boolean; user: TestUser | null };
  background: Array<Promise<unknown>>;
}

export const runtime: RuntimeState = {
  sqlite: null,
  db: null,
  storage: new InMemoryStorage(),
  vars: new Map(),
  secrets: new Map(),
  auth: { authenticated: false, user: null },
  background: [],
};

const migrationsDir = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));

function applyMigrations(sqlite: Database.Database): void {
  sqlite.pragma("foreign_keys = ON");
  const migrationFiles = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
    for (const statement of statements) {
      try {
        sqlite.exec(statement);
      } catch (error) {
        if (/using fts5/i.test(statement) && /no such module: fts5/i.test(String(error))) continue;
        throw error;
      }
    }
  }
}

// es_system__auth_user is a PLATFORM table (managed by EdgeSpark), so it is absent from
// the app's drizzle/ migrations. Owner resolution (resolveOwnerUserId) reads it, so the
// harness creates a minimal copy here.
function createSystemAuthUser(sqlite: Database.Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS es_system__auth_user (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    email_verified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    is_anonymous INTEGER DEFAULT 0,
    banned INTEGER DEFAULT 0,
    ban_reason TEXT,
    ban_expires INTEGER,
    last_login_at INTEGER
  );`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS es_system__auth_user_email_unique ON es_system__auth_user(email);`);
}

function createDb() {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  createSystemAuthUser(sqlite);
  const db = drizzle(sqlite, { schema: drizzleSchema }) as any;
  // better-sqlite3 Drizzle does not expose D1's db.batch. The production code
  // only needs ordered statement execution in these tests, so the shim awaits
  // each Drizzle query sequentially and returns the D1-like result array.
  db.batch = async (statements: readonly Promise<unknown>[]) => {
    const results: unknown[] = [];
    for (const statement of statements) results.push(await statement);
    return results;
  };
  return { sqlite, db };
}

export function resetRuntime(): RuntimeState {
  runtime.sqlite?.close();
  const { sqlite, db } = createDb();
  runtime.sqlite = sqlite;
  runtime.db = db;
  runtime.storage = new InMemoryStorage();
  runtime.vars = new Map();
  runtime.secrets = new Map();
  runtime.auth = { authenticated: false, user: null };
  runtime.background = [];
  return runtime;
}

export function useSession(user: Partial<TestUser> = {}): void {
  runtime.auth = {
    authenticated: true,
    user: {
      id: user.id ?? "owner-user",
      email: user.email ?? "owner@example.test",
      name: user.name ?? "Owner",
      image: user.image ?? null,
      emailVerified: user.emailVerified ?? true,
      isAnonymous: user.isAnonymous ?? false,
      createdAt: user.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
    },
  };
}

/**
 * Insert a row into the platform auth-user table and return its id. Owner resolution
 * (resolveOwnerUserId) reads this table via OWNER_EMAIL.
 */
export function seedOwner(options: { email?: string; id?: string; name?: string } = {}): string {
  const id = options.id ?? "owner-user";
  const email = options.email ?? "owner@example.test";
  runtime.sqlite?.prepare(
    `INSERT OR REPLACE INTO es_system__auth_user (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, 1, 0, 0)`
  ).run(id, options.name ?? "Owner", email);
  return id;
}

/**
 * Clear any authenticated session so a following `app.request` with an `Authorization`
 * header is handled on the bearer path. `requireDualAuth` prefers an authenticated
 * session over a bearer header, so a manually-attached token is otherwise ignored while
 * a session (e.g. the admin who just ran a suspend) is still active.
 */
export function clearSession(): void {
  runtime.auth = { authenticated: false, user: null };
}

export function useBearer(scopes: readonly string[], token = "integration-agent-token"): HeadersInit {
  runtime.auth = { authenticated: false, user: null };
  runtime.secrets.set("AGENT_TOKEN", token);
  runtime.vars.set("AGENT_TOKEN_SCOPES", scopes.join(" "));
  return { authorization: `Bearer ${token}` };
}

export function jsonHeaders(extra: HeadersInit = {}): HeadersInit {
  return { "content-type": "application/json", ...extra };
}

function parentOf(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  return slash <= 0 ? "/" : pathname.slice(0, slash);
}

function basename(pathname: string): string {
  return pathname.split("/").filter(Boolean).pop() ?? pathname;
}

export async function seedFolder(folderPath: string, ownerId: string | null = null): Promise<void> {
  if (folderPath === "/") return;
  const segments = folderPath.slice(1).split("/").filter(Boolean);
  let cursor = "";
  for (const segment of segments) {
    cursor += `/${segment}`;
    const [existing] = await runtime.db.select({ id: files.id }).from(files).where(eq(files.path, cursor)).limit(1);
    if (existing) continue;
    const timestamp = new Date().toISOString();
    await runtime.db.insert(files).values({
      id: `folder-${cursor.replace(/[^a-z0-9]+/giu, "-")}`,
      name: segment,
      path: cursor,
      parentPath: parentOf(cursor),
      isFolder: 1,
      size: 0,
      contentType: null,
      s3Uri: null,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      ownerId,
    } as never);
  }
}

export async function seedDriveFile(options: {
  id?: string;
  path: string;
  body?: string | Uint8Array;
  contentType?: string;
  ownerId?: string | null;
}): Promise<string> {
  const id = options.id ?? `file-${Math.random().toString(36).slice(2)}`;
  const bytes = typeof options.body === "string"
    ? new TextEncoder().encode(options.body)
    : options.body ?? new Uint8Array([1, 2, 3]);
  const parentPath = parentOf(options.path);
  const name = basename(options.path);
  const ownerId = options.ownerId ?? null;
  await seedFolder(parentPath, ownerId);
  const objectPath = driveObjectKey(id, name);
  await runtime.storage.from(buckets.drive).put(objectPath, bytes, {
    contentType: options.contentType ?? "text/plain",
  });
  const timestamp = new Date().toISOString();
  await runtime.db.insert(files).values({
    id,
    name,
    path: options.path,
    parentPath,
    isFolder: 0,
    size: bytes.byteLength,
    contentType: options.contentType ?? "text/plain",
    s3Uri: runtime.storage.createS3Uri(buckets.drive, objectPath),
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ownerId,
  } as never);
  return id;
}

export async function seedMemory(options: { id?: string; key?: string | null; content: string; tags?: string | null; ownerId?: string | null }): Promise<string> {
  const id = options.id ?? `mem-${Math.random().toString(36).slice(2)}`;
  const ts = new Date().toISOString();
  await runtime.db.insert(memories).values({
    id, key: options.key ?? null, content: options.content, tags: options.tags ?? null,
    source: null, createdAt: ts, updatedAt: ts, ownerId: options.ownerId ?? null,
  } as never);
  await runtime.db.insert(sqliteTable("memories_fts", { id: text("id").notNull(), content: text("content").notNull(), tags: text("tags").notNull() }))
    .values({ id, content: options.content, tags: options.tags ?? "" } as never).catch(() => {});
  return id;
}

export async function seedShareRow(options: { id: string; fileId?: string | null; folderPath?: string | null; ownerId?: string | null }): Promise<void> {
  await runtime.db.insert(shares).values({
    id: options.id, fileId: options.fileId ?? null, folderPath: options.folderPath ?? null,
    downloadCount: 0, createdAt: new Date().toISOString(), ownerId: options.ownerId ?? null,
  } as never);
}

export async function seedBundleRow(options: { id: string; prefix: string; publicId?: string | null; ownerId?: string | null }): Promise<void> {
  const ts = new Date().toISOString();
  await runtime.db.insert(bundleVersions).values({
    id: options.id, prefix: options.prefix, publicId: options.publicId ?? null, currentVersionId: "dv_seed",
    machineId: "m", hash: "h", fileCount: 0, totalSize: 0, pushedAt: ts, updatedAt: ts,
    ownerId: options.ownerId ?? null,
  } as never);
}

export async function seedContact(options: {
  id?: string;
  name: string;
  url: string;
  publicKeyJwk: JsonWebKey;
  autoRelease?: boolean;
  ownerId?: string | null;
}): Promise<void> {
  await runtime.db.insert(contacts).values({
    id: options.id ?? `contact-${options.name}`,
    name: options.name,
    url: options.url.replace(/\/+$/u, ""),
    publicKeyJwk: JSON.stringify(options.publicKeyJwk),
    algorithm: "Ed25519",
    autoRelease: options.autoRelease ? 1 : 0,
    addedAt: new Date().toISOString(),
    ownerId: options.ownerId ?? null,
  } as never);
}

export async function seedPublishedBundle(ownerId: string | null = null): Promise<{ publicId: string; prefix: string }> {
  const prefix = "/bundle";
  const publicId = "pb_test_bundle";
  const manifest = {
    version: 1,
    name: "integration-bundle",
    hash: "hash-current",
    machineId: "machine-a",
    pushedAt: new Date().toISOString(),
    versionId: "dv_current",
    previousVersionId: null,
    fileCount: 1,
    totalSize: 2,
    files: [{ path: "ok.txt", hash: "hash-ok", size: 2 }],
    directories: [],
  };
  await seedDriveFile({ id: "manifest-file", path: `${prefix}/manifest.json`, body: JSON.stringify(manifest), contentType: "application/json", ownerId });
  await seedDriveFile({ id: "ok-file", path: `${prefix}/ok.txt`, body: "ok", contentType: "text/plain", ownerId });
  await seedDriveFile({ id: "secret-file", path: `${prefix}/secret.txt`, body: "no", contentType: "text/plain", ownerId });
  await runtime.db.insert(bundleVersions).values({
    id: `bv-${prefix.replace(/\W+/gu, "-")}`,
    prefix,
    publicId,
    currentVersionId: "dv_current",
    previousVersionId: null,
    machineId: "machine-a",
    hash: "hash-current",
    fileCount: 1,
    totalSize: 2,
    pushedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerId,
  });
  return { publicId, prefix };
}

resetRuntime();
