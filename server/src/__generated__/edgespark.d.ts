/**
 * Universally available EdgeSpark imports.
 *
 * Anything exported from `edgespark` is intended to be importable everywhere.
 */
declare module "edgespark" {
  export const db: import("drizzle-orm/d1").DrizzleD1Database<
    typeof import("../defs").drizzleSchema
  >;
  export const storage: import("./server-types").StorageClient;
  export const vars: import("./server-types").VarClient<
    import("../defs").VarKey
  >;
  export const secret: import("./server-types").SecretClient<
    import("../defs").SecretKey
  >;
  export const ctx: import("./server-types").ExecutionCtx;
}

/**
 * HTTP-only EdgeSpark imports.
 *
 * Anything exported from `edgespark/http` is intended to be imported only in
 * HTTP request handlers.
 *
 * Do not import these in cron jobs or queue consumers.
 */
declare module "edgespark/http" {
  /** Request-scoped auth. Only available in HTTP handlers. */
  export const auth: import("./server-types").AuthClient;
}