import { ApiError } from "./errors";

export function normalizePath(input?: string | null): string {
  if (!input || input.trim() === "") return "/";

  let path = input.trim();
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  return path || "/";
}

export function normalizeName(input: string | undefined): string {
  const name = (input ?? "").trim();
  if (!name) throw new ApiError(400, "validation_error", "Name is required");
  if (name.includes("/")) {
    throw new ApiError(400, "validation_error", "Name cannot contain '/'");
  }
  return name;
}

export function joinPath(parentPath: string, name: string): string {
  const parent = normalizePath(parentPath);
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

export function parentOfPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

export function descendantPattern(path: string): string {
  const normalized = normalizePath(path);
  return normalized === "/" ? "/%" : `${normalized}/%`;
}

export function relativePath(fullPath: string, basePath: string): string {
  const full = normalizePath(fullPath);
  const base = normalizePath(basePath);
  if (base === "/") return full.startsWith("/") ? full.slice(1) : full;
  if (full === base) return "";
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
}
