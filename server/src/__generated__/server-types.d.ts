/**
 * EdgeSpark Server SDK Types
 *
 * This file is managed by `edgespark pull types`.
 * Run `edgespark pull types` to update to the latest version.
 *
 * DO NOT EDIT - changes will be overwritten on next pull.
 */

/**
 * EdgeSpark server SDK types.
 *
 * Runtime imports:
 * - `import { db, storage, vars, secret, ctx } from "edgespark"`
 * - `import { auth } from "edgespark/http"`
 *
 * Read this file as the public contract. The names and examples here are
 * intentionally optimized for coding agents.
 */

// =============================================================================
// COMMON
// =============================================================================

export type DeploymentEnv = "production" | "staging";

/** Request-scoped runtime utilities from `import { ctx } from "edgespark"`. */
export interface ExecutionCtx {
  /** Deployment environment for the current request. */
  readonly environment: DeploymentEnv;
  /**
   * Continue work after the response is sent.
   * @example ctx.runInBackground(sendAnalytics());
   */
  runInBackground(promise: Promise<unknown>): void;
}

// =============================================================================
// VARS
// =============================================================================

/** Runtime vars from `import { vars } from "edgespark"`. */
export interface VarClient<K extends string = string> {
  /**
   * Read a plain-text runtime var by key.
   * @example const apiBaseUrl = vars.get("API_BASE_URL");
   */
  get(name: K): string | null;
}

// =============================================================================
// SECRET
// =============================================================================

/** Secrets from `import { secret } from "edgespark"`. */
export interface SecretClient<K extends string = string> {
  /**
   * Read a secret value by key.
   * @example const webhookSecret = secret.get("WEBHOOK_SECRET");
   */
  get(name: K): string | null;
}

// =============================================================================
// AUTH
// =============================================================================

/** Authenticated user for the current request. */
export interface User {
  readonly id: string;
  readonly email: string | null;
  readonly name: string | null;
  /** Profile image URL. */
  readonly image: string | null;
  readonly emailVerified: boolean;
  readonly isAnonymous: boolean;
  readonly createdAt: Date;
}

/** Auth client narrowed to a guaranteed user. */
export interface AuthenticatedAuthClient extends AuthClient {
  readonly user: User;
}

/** Request-scoped auth from `import { auth } from "edgespark/http"`. */
export interface AuthClient {
  /**
   * Current user for this request. `null` when the route allows unauthenticated access.
   * - `/api/*`: guaranteed user
   * - `/api/public/*`: user or `null`
   * - `/api/webhooks/*`: always `null`
   */
  readonly user: User | null;
  /**
   * Narrow `auth.user` to `User`.
   * @example
   * if (auth.isAuthenticated()) {
   *   auth.user.id;
   * }
   */
  isAuthenticated(): this is AuthenticatedAuthClient;
}

// =============================================================================
// STORAGE TYPES
// =============================================================================

/**
 * Bucket definition from `src/defs/storage_schema.ts`.
 */
export interface BucketDef<Name extends string = string> {
  readonly bucket_name: Name;
  readonly description: string;
}

/** S3-style object reference (`s3://bucket/path`). Persist this in your database. */
export type S3Uri<BucketName extends string = string> =
  `s3://${BucketName}/${string}`;

/** Binary payload accepted by `bucket.put()`. */
export type StoragePutBody = ArrayBuffer | ArrayBufferView;

/** HTTP metadata stored with an object. */
export interface StorageHttpMetadata {
  readonly contentType?: string;
  readonly contentDisposition?: string;
  readonly contentEncoding?: string;
  readonly cacheControl?: string;
}

/** Metadata returned by `head()` and `get()`. */
export interface StorageObjectMetadata extends StorageHttpMetadata {
  readonly size: number;
}

/** Object returned by `get()`. */
export interface StorageObject {
  readonly body: ArrayBuffer;
  readonly metadata: StorageObjectMetadata;
}

/** File entry returned by `list()`. */
export interface StorageFileInfo {
  readonly path: string;
  readonly size: number;
  readonly uploadedAt: Date;
}

/** Options for `bucket.list()`. */
export interface StorageListOptions {
  /** Maximum number of files to return. Default: `1000`. Max: `1000`. */
  readonly limit?: number;
  /** Only return files whose paths start with this prefix. */
  readonly prefix?: string;
  /** Continue from a previous `list()` result. */
  readonly cursor?: string;
  /** Group child paths into `delimitedPrefixes` instead of returning every file. Usually `"/"`. */
  readonly delimiter?: string;
}

/** Result returned by `bucket.list()`. */
export interface StorageListResult {
  readonly files: readonly StorageFileInfo[];
  readonly hasMore: boolean;
  readonly cursor?: string;
  /** Grouped prefixes when `delimiter` is used. */
  readonly delimitedPrefixes: readonly string[];
}

// =============================================================================
// STORAGE CLIENTS
// =============================================================================

/** Storage entrypoint from `import { storage } from "edgespark"`. */
export interface StorageClient {
  /** Select a bucket for file operations. */
  from<Name extends string>(bucket: BucketDef<Name>): BucketClient<Name>;
  /**
   * Create an S3 URI for a file path in a bucket.
   * @example const s3Uri = storage.createS3Uri(buckets.avatars, "users/1/photo.jpg");
   */
  createS3Uri<Name extends string>(
    bucket: BucketDef<Name>,
    path: string
  ): S3Uri<Name>;
  /**
   * Check whether an arbitrary string is a valid `S3Uri`.
   * @example
   * if (storage.isS3Uri(value)) {
   *   storage.parseS3Uri(value);
   * }
   */
  isS3Uri(value: string): value is S3Uri;
  /**
   * Parse an S3 URI into bucket + path. Throws if the string is not a valid S3 URI.
   * @example const { bucket, path } = storage.parseS3Uri(row.photo_s3_uri);
   */
  parseS3Uri(
    s3Uri: string
  ): {
    readonly bucket: BucketDef;
    readonly path: string;
  };
  /**
   * Parse an S3 URI into bucket + path, or return `null` if invalid.
   * @example const parsed = storage.tryParseS3Uri(untrustedInput);
   */
  tryParseS3Uri(s3Uri: string): {
    readonly bucket: BucketDef;
    readonly path: string;
  } | null;
}

/** File operations for one bucket. */
export interface BucketClient<BucketName extends string = string> {
  /**
   * Upload a file. Prefer `createPresignedPutUrl()` for large client uploads.
   * @example await storage.from(buckets.exports).put("report.csv", csvBytes);
   */
  put(
    path: string,
    file: StoragePutBody,
    options?: StorageHttpMetadata
  ): Promise<void>;
  /**
   * Download a file. Returns `null` when it does not exist.
   * @example const file = await storage.from(buckets.uploads).get("file.txt");
   */
  get(path: string): Promise<StorageObject | null>;
  /**
   * Read file metadata without downloading the file. Returns `null` if the file does not exist.
   * @example const meta = await storage.from(buckets.uploads).head("file.txt");
   */
  head(path: string): Promise<StorageObjectMetadata | null>;
  /**
   * List files in the current bucket.
   * @example const page = await storage.from(buckets.uploads).list({ prefix: "user-1/" });
   */
  list(options?: StorageListOptions): Promise<StorageListResult>;
  /**
   * Delete one file or many files.
   * @example await storage.from(buckets.temp).delete(["a.txt", "b.txt"]);
   */
  delete(paths: string | readonly string[]): Promise<void>;
  /**
   * Create a presigned PUT URL for a direct client upload.
   * Send the returned `requiredHeaders` exactly as-is with the PUT request.
   * @example
   * const { uploadUrl, requiredHeaders } = await storage.from(buckets.uploads).createPresignedPutUrl("image.jpg", 3600, {
   *   contentType: "image/jpeg",
   * });
   */
  createPresignedPutUrl(
    path: string,
    expiresInSecs?: number,
    options?: StorageHttpMetadata
  ): Promise<{
    readonly uploadUrl: string;
    readonly expiresAt: Date;
    /** Required request headers for the PUT upload. */
    readonly requiredHeaders: Readonly<Record<string, string>>;
  }>;
  /**
   * Create a presigned GET URL for a direct client download.
   * @example const { downloadUrl } = await storage.from(buckets.uploads).createPresignedGetUrl("image.jpg", 3600);
   */
  createPresignedGetUrl(path: string, expiresInSecs?: number): Promise<{
    readonly downloadUrl: string;
    readonly expiresAt: Date;
  }>;
}