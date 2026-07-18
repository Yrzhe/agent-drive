/**
 * The `pending:` marker stored in `files.s3Uri` while an upload's presigned PUT
 * URL is outstanding. Encodes the declared size AND the object's key at the
 * time the presigned URL was minted (#50).
 *
 * A pending row's NAME can legitimately change afterward — `PATCH /v1/files/:id`
 * is used, for example, to move a pending row out of the way to clear a restore
 * path-conflict — but the R2 object key it presigned is fixed the moment the
 * PUT URL is issued. Recomputing the key from the CURRENT name at completion or
 * cleanup time desyncs from the object the client actually PUT: completion
 * 404s (`upload_not_found`) and cleanup deletes the wrong (never-written) key,
 * orphaning the real object. Storing the original key here and resolving from
 * it everywhere keeps rename support working without desyncing the key.
 *
 * Format: `pending:{declaredSize}:{encodeURIComponent(objectKey)}`.
 * `declaredSize` is numeric and never contains `:`, and the key segment is
 * percent-encoded, so splitting the post-prefix string on the FIRST `:` is
 * unambiguous.
 *
 * Backward compatibility: existing rows created before this change carry the
 * OLD format, `pending:{declaredSize}` (no key segment). Both readers below
 * still parse it — `readPendingUploadObjectKey` returns `null` for it, and
 * callers fall back to deriving the key from the row's current name.
 */

export const PENDING_UPLOAD_PREFIX = "pending:";

export function createPendingUploadMarker(declaredSize: number, objectKey: string): string {
  return `${PENDING_UPLOAD_PREFIX}${declaredSize}:${encodeURIComponent(objectKey)}`;
}

export function readPendingUploadDeclaredSize(marker: string | null): number | null {
  if (!marker || !marker.startsWith(PENDING_UPLOAD_PREFIX)) return null;
  const rest = marker.slice(PENDING_UPLOAD_PREFIX.length);
  const colonIndex = rest.indexOf(":");
  const sizeSegment = colonIndex === -1 ? rest : rest.slice(0, colonIndex);
  const size = Number(sizeSegment);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

/** Decoded original object key, or `null` for old markers (or non-pending markers). */
export function readPendingUploadObjectKey(marker: string | null | undefined): string | null {
  if (!marker || !marker.startsWith(PENDING_UPLOAD_PREFIX)) return null;
  const rest = marker.slice(PENDING_UPLOAD_PREFIX.length);
  const colonIndex = rest.indexOf(":");
  if (colonIndex === -1) return null;
  const encodedKey = rest.slice(colonIndex + 1);
  try {
    return decodeURIComponent(encodedKey);
  } catch {
    return null;
  }
}
