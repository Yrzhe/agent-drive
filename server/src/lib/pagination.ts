/** Parse limit/offset query params with clamping. */
export function parseListPagination(
  query: (name: string) => string | undefined,
  options: { defaultLimit: number; maxLimit: number }
): { limit: number; offset: number } {
  const limitRaw = Number(query("limit") ?? String(options.defaultLimit));
  const offsetRaw = Number(query("offset") ?? "0");
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(options.maxLimit, Math.trunc(limitRaw)))
    : options.defaultLimit;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;
  return { limit, offset };
}
