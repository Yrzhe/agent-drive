/**
 * The single definition of a drive object's R2 key.
 *
 * The storage SDK's `path` argument means two different things depending on the
 * API family, which is the trap behind #44:
 *
 * - **binding** (`put` / `get` / `head` / `delete`) — `path` is a **literal key**.
 *   No decoding happens; the object lands at exactly the string you pass.
 * - **presign** (`createPresignedPutUrl` / `createPresignedGetUrl`) — `path` is
 *   embedded in the URL **verbatim**, and S3/R2 URL-decodes it **once** when it
 *   serves the request. The effective key is therefore `decodeURIComponent(path)`.
 *
 * Verified against production: handing the presign family an already-encoded path
 * returned a signed URL still containing `%E6…` — not `%25E6…` — so the presign
 * family adds no encoding of its own.
 *
 * Handing both families the same pre-encoded string therefore lands on two
 * different keys for any name where `encodeURIComponent` is not a no-op. ASCII
 * names are a no-op, which is exactly why this stayed hidden.
 *
 * The contract here: the **canonical key is raw**. Give it to the binding as-is,
 * and percent-encode it only when handing it to the presign family.
 */

/**
 * Canonical drive object key — raw, human-readable in R2, and the form stored in
 * `files.s3Uri`. Prefer resolving an existing object's key from its stored
 * `s3Uri` over recomputing it from the current filename: a rename changes the
 * name but not the key.
 */
export function driveObjectKey(fileId: string, filename: string): string {
  return `${fileId}/${filename}`;
}

/**
 * Percent-encode a canonical key for the presign family. Each segment is encoded
 * independently so `/` keeps working as a path separator in the signed URL.
 */
export function presignPath(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
