export function normalizePath(input?: string | null): string {
  const raw = (input ?? "").trim();
  if (!raw) return "/";
  const cleaned = raw.replace(/\\+/g, "/");
  const prefixed = cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
  const compacted = prefixed.replace(/\/{2,}/g, "/");
  return compacted.length > 1 && compacted.endsWith("/") ? compacted.slice(0, -1) : compacted;
}

export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

export function joinPath(parentPath: string, name: string): string {
  const parent = normalizePath(parentPath);
  const safeName = name.split("/").join("-").trim();
  return parent === "/" ? `/${safeName}` : `${parent}/${safeName}`;
}
