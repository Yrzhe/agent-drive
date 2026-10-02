import type { AppDb, FileRow } from "../types";
import type { SecretKey, VarKey } from "../defs/runtime";

export interface PlatformUser {
  readonly id: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly image: string | null;
  readonly emailVerified: boolean;
  readonly isAnonymous: boolean;
  readonly createdAt: Date;
}
export interface PlatformAuth {
  readonly user: PlatformUser | null;
  isAuthenticated(): this is PlatformAuth & { readonly user: PlatformUser };
}
export interface BucketDef<Name extends string = string> {
  readonly bucket_name: Name;
  readonly description: string;
}
export interface ObjectMetadata {
  readonly size: number;
  readonly contentType?: string;
  readonly contentDisposition?: string;
  readonly contentEncoding?: string;
  readonly cacheControl?: string;
}
export type HttpMetadata = Omit<ObjectMetadata, "size">;
export interface PlatformBucket {
  put(path: string, body: ArrayBuffer | ArrayBufferView, options?: HttpMetadata): Promise<void>;
  get(path: string): Promise<{ body: ArrayBuffer; metadata: ObjectMetadata } | null>;
  head(path: string): Promise<ObjectMetadata | null>;
  list(options?: { limit?: number; prefix?: string; cursor?: string; delimiter?: string }): Promise<{
    readonly files: readonly { path: string; size: number; uploadedAt: Date }[];
    readonly hasMore: boolean;
    readonly cursor?: string;
    readonly delimitedPrefixes: readonly string[];
  }>;
  delete(paths: string | readonly string[]): Promise<void>;
  createPresignedPutUrl(path: string, expiresInSecs?: number, options?: HttpMetadata): Promise<{
    readonly uploadUrl: string;
    readonly expiresAt: Date;
    readonly requiredHeaders: Readonly<Record<string, string>>;
    readonly multipart?: { readonly partSize: number };
  }>;
  createPresignedGetUrl(path: string, expiresInSecs?: number): Promise<{
    readonly downloadUrl: string;
    readonly expiresAt: Date;
  }>;
}
export interface PlatformStorage {
  from(bucket: BucketDef): PlatformBucket;
  createS3Uri<Name extends string>(bucket: BucketDef<Name>, path: string): `s3://${Name}/${string}`;
  isS3Uri(value: string): value is `s3://${string}/${string}`;
  parseS3Uri(value: string): { readonly bucket: BucketDef; readonly path: string };
  tryParseS3Uri(value: string): { readonly bucket: BucketDef; readonly path: string } | null;
}
export interface PlatformRuntime {
  readonly kind: "edgespark" | "sites";
  readonly maxUploadBytes?: number;
  readonly hasLiveUpload?: (fileId: string) => Promise<boolean>;
  readonly db: AppDb;
  readonly storage: PlatformStorage;
  readonly auth: PlatformAuth;
  readonly vars: { get(name: VarKey): string | null };
  readonly secret: { get(name: SecretKey): string | null };
  readonly ctx: { readonly environment: "staging" | "production"; runInBackground(promise: Promise<unknown>): void };
  readonly versioning?: {
    extraUsageBytes(): Promise<number>;
    writeText(existing: FileRow | undefined, values: Omit<FileRow, "deletedAt" | "s3Uri">, bytes: Uint8Array): Promise<FileRow>;
    pinShare(shareId: string, file: FileRow, versionId?: string): Promise<string>;
    resolveShare(shareId: string, file: FileRow): Promise<FileRow>;
    shareDetails(ids: string[]): Promise<Map<string, { shareMode: "fixed"; versionId: string }>>;
  };
}
