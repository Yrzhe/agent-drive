import type {
  CreateShareInput,
  DriveFile,
  GuideData,
  ShareAccessResult,
  ShareDownloadResult,
  ShareInfo,
  ShareLink,
  ShareStatus,
  UploadTicket,
} from "@/types/drive";
import { DriveApiError } from "@/lib/api-client";
import { getParentPath, joinPath, normalizePath } from "@/lib/path-utils";

type ShareRecord = {
  id: string;
  fileId: string | null;
  folderPath: string | null;
  password: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  expiresAt: string | null;
  createdAt: string;
};
type PendingUpload = { filename: string; contentType: string; size: number; path: string };
const nowIso = () => new Date().toISOString();

const guide: GuideData = {
  title: "Agent Drive Guide",
  intro: "Agent Drive is a private cloud drive for both agents and humans.",
  sections: [
    {
      title: "Upload flow",
      content: "Request an upload ticket, PUT to presigned URL, then call upload complete.",
    },
    {
      title: "Dashboard flow",
      content: "Browse folders, upload files, rename/delete items, and create share links.",
    },
    {
      title: "Share controls",
      content: "Share links can have password, expiration date, and max download limits.",
    },
  ],
};

let fileCounter = 6;
let shareCounter = 3;
let files: DriveFile[] = [
  { id: "file_1", name: "docs", path: "/docs", parentPath: "/", isFolder: true, size: 0, contentType: null, createdAt: nowIso(), updatedAt: nowIso(), s3Uri: null },
  { id: "file_2", name: "readme.md", path: "/docs/readme.md", parentPath: "/docs", isFolder: false, size: 2401, contentType: "text/markdown", createdAt: nowIso(), updatedAt: nowIso(), s3Uri: "mock://bucket/docs/readme.md" },
  { id: "file_3", name: "meeting-notes.txt", path: "/meeting-notes.txt", parentPath: "/", isFolder: false, size: 913, contentType: "text/plain", createdAt: nowIso(), updatedAt: nowIso(), s3Uri: "mock://bucket/meeting-notes.txt" },
  { id: "file_4", name: "assets", path: "/assets", parentPath: "/", isFolder: true, size: 0, contentType: null, createdAt: nowIso(), updatedAt: nowIso(), s3Uri: null },
  { id: "file_5", name: "logo.png", path: "/assets/logo.png", parentPath: "/assets", isFolder: false, size: 147822, contentType: "image/png", createdAt: nowIso(), updatedAt: nowIso(), s3Uri: "mock://bucket/assets/logo.png" },
];
let shares: ShareRecord[] = [
  { id: "share1234", fileId: "file_3", folderPath: null, password: null, maxDownloads: 10, downloadCount: 2, expiresAt: null, createdAt: nowIso() },
  { id: "folder001", fileId: null, folderPath: "/docs", password: "demo", maxDownloads: 5, downloadCount: 1, expiresAt: null, createdAt: nowIso() },
];
const pendingUploads = new Map<string, PendingUpload>();
const shareTokens = new Map<string, string>();

const findFile = (id: string) => files.find((file) => file.id === id) ?? null;
const shareMessage = (status: ShareStatus) =>
  status === "expired" ? "This share link has expired." : status === "depleted" ? "This share link reached max downloads." : status === "not_found" ? "Share link not found." : undefined;
const shareStatus = (share: ShareRecord): ShareStatus =>
  share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now() ? "expired" : share.maxDownloads !== null && share.downloadCount >= share.maxDownloads ? "depleted" : "active";
const shareUrl = (id: string) => (typeof window === "undefined" ? `/s/${id}` : `${window.location.origin}/s/${id}`);
const toShareLink = (share: ShareRecord): ShareLink => ({ id: share.id, fileId: share.fileId, folderPath: share.folderPath, type: share.fileId ? "file" : "folder", targetName: share.fileId ? (files.find((f) => f.id === share.fileId)?.name ?? "unknown") : (share.folderPath ?? "/"), shareUrl: shareUrl(share.id), hasPassword: share.password !== null, maxDownloads: share.maxDownloads, downloadCount: share.downloadCount, expiresAt: share.expiresAt, createdAt: share.createdAt });

function ensureFolder(path: string): void {
  const normalized = normalizePath(path);
  if (normalized === "/") return;
  let current = "";
  for (const segment of normalized.split("/").filter(Boolean)) {
    current = `${current}/${segment}`;
    if (files.some((entry) => entry.path === current)) continue;
    const createdAt = nowIso();
    fileCounter += 1;
    files.push({ id: `file_${fileCounter}`, name: segment, path: current, parentPath: getParentPath(current), isFolder: true, size: 0, contentType: null, createdAt, updatedAt: createdAt, s3Uri: null });
  }
}

function renameWithChildren(target: DriveFile, nextPath: string, nextParentPath: string): void {
  const previous = target.path;
  target.path = nextPath;
  target.parentPath = nextParentPath;
  target.name = nextPath.split("/").filter(Boolean).slice(-1)[0] ?? target.name;
  target.updatedAt = nowIso();
  if (!target.isFolder) return;
  files = files.map((entry) => {
    if (!entry.path.startsWith(`${previous}/`)) return entry;
    const path = `${nextPath}/${entry.path.slice(previous.length + 1)}`;
    return { ...entry, path, parentPath: getParentPath(path), updatedAt: nowIso() };
  });
}

function deleteEntry(fileId: string): { deleted: number } {
  const target = findFile(fileId);
  if (!target) throw new DriveApiError("File not found", 404, "FILE_NOT_FOUND");
  const toDelete = files.filter((entry) => entry.id === fileId || entry.path.startsWith(`${target.path}/`));
  const deleteIds = new Set(toDelete.map((entry) => entry.id));
  const deletePaths = new Set(toDelete.map((entry) => entry.path));
  files = files.filter((entry) => !deleteIds.has(entry.id));
  shares = shares.filter((share) => !(share.fileId && deleteIds.has(share.fileId)) && !(share.folderPath && deletePaths.has(share.folderPath)));
  return { deleted: toDelete.filter((entry) => !entry.isFolder).length };
}

function resolveShare(shareId: string): ShareInfo {
  const share = shares.find((entry) => entry.id === shareId);
  if (!share) return { id: shareId, file: null, folderPath: null, requiresPassword: false, maxDownloads: null, downloadCount: 0, expiresAt: null, status: "not_found", message: shareMessage("not_found") };
  const status = shareStatus(share);
  return { id: share.id, file: share.fileId ? findFile(share.fileId) : null, folderPath: share.folderPath, requiresPassword: share.password !== null, maxDownloads: share.maxDownloads, downloadCount: share.downloadCount, expiresAt: share.expiresAt, status, message: shareMessage(status) };
}

export const mockDriveApi = {
  async listFiles(path: string): Promise<{ files: DriveFile[]; path: string }> {
    const normalized = normalizePath(path);
    return { files: files.filter((entry) => entry.parentPath === normalized).sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1)), path: normalized };
  },
  async requestUpload(input: { filename: string; contentType: string; size: number; path: string }): Promise<UploadTicket> {
    const path = normalizePath(input.path); ensureFolder(path); fileCounter += 1;
    const fileId = `file_${fileCounter}`; pendingUploads.set(fileId, { ...input, path });
    return { fileId, uploadUrl: `mock://upload/${fileId}`, requiredHeaders: {}, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
  },
  async completeUpload(fileId: string): Promise<{ file: DriveFile }> {
    const pending = pendingUploads.get(fileId); if (!pending) throw new DriveApiError("Upload ticket not found", 404, "UPLOAD_NOT_FOUND");
    const path = joinPath(pending.path, pending.filename); if (files.some((entry) => entry.path === path)) throw new DriveApiError("A file with this path already exists", 409, "FILE_EXISTS");
    const createdAt = nowIso(); const file: DriveFile = { id: fileId, name: pending.filename, path, parentPath: pending.path, isFolder: false, size: pending.size, contentType: pending.contentType, createdAt, updatedAt: createdAt, s3Uri: `mock://bucket${path}` };
    files.push(file); pendingUploads.delete(fileId); return { file };
  },
  async createFolder(name: string, parentPath: string): Promise<{ folder: DriveFile }> {
    const parent = normalizePath(parentPath); ensureFolder(parent); const path = joinPath(parent, name);
    if (files.some((entry) => entry.path === path)) throw new DriveApiError("A folder with this path already exists", 409, "FOLDER_EXISTS");
    fileCounter += 1; const createdAt = nowIso(); const folder: DriveFile = { id: `file_${fileCounter}`, name, path, parentPath: parent, isFolder: true, size: 0, contentType: null, createdAt, updatedAt: createdAt, s3Uri: null };
    files.push(folder); return { folder };
  },
  async renameFile(fileId: string, payload: { name?: string; parentPath?: string }): Promise<{ file: DriveFile }> {
    const target = findFile(fileId); if (!target) throw new DriveApiError("File not found", 404, "FILE_NOT_FOUND");
    const nextName = payload.name?.trim() || target.name; const nextParent = payload.parentPath ? normalizePath(payload.parentPath) : target.parentPath; const nextPath = joinPath(nextParent, nextName);
    if (target.path !== nextPath && files.some((entry) => entry.path === nextPath)) throw new DriveApiError("Target path already exists", 409, "PATH_EXISTS");
    renameWithChildren(target, nextPath, nextParent); return { file: target };
  },
  async deleteFile(fileId: string): Promise<{ deleted: number }> { return deleteEntry(fileId); },
  async listShares(): Promise<{ shares: ShareLink[] }> { return { shares: shares.map(toShareLink) }; },
  async createShare(input: CreateShareInput): Promise<{ share: ShareLink }> {
    if (!input.fileId && !input.folderPath) throw new DriveApiError("fileId or folderPath is required", 400, "INVALID_INPUT");
    if (input.fileId && input.folderPath) throw new DriveApiError("Provide either fileId or folderPath, not both", 400, "INVALID_INPUT");
    if (input.fileId && !findFile(input.fileId)) throw new DriveApiError("File not found", 404, "FILE_NOT_FOUND");
    if (input.folderPath && !files.some((entry) => entry.path === input.folderPath && entry.isFolder)) throw new DriveApiError("Folder not found", 404, "FOLDER_NOT_FOUND");
    shareCounter += 1; const share: ShareRecord = { id: `share${String(shareCounter).padStart(4, "0")}`, fileId: input.fileId ?? null, folderPath: input.folderPath ?? null, password: input.password?.trim() || null, maxDownloads: input.maxDownloads ?? null, downloadCount: 0, expiresAt: input.expiresAt ?? null, createdAt: nowIso() };
    shares.unshift(share); return { share: toShareLink(share) };
  },
  async getShareInfo(shareId: string): Promise<ShareInfo> { return resolveShare(shareId); },
  async accessShare(shareId: string, password?: string): Promise<ShareAccessResult> {
    const share = shares.find((entry) => entry.id === shareId); if (!share) throw new DriveApiError(shareMessage("not_found") ?? "Share not found", 404, "SHARE_NOT_FOUND");
    const status = shareStatus(share); if (status === "expired") throw new DriveApiError(shareMessage("expired") ?? "Share expired", 410, "SHARE_EXPIRED"); if (status === "depleted") throw new DriveApiError(shareMessage("depleted") ?? "Download limit reached", 410, "DOWNLOAD_LIMIT");
    if (share.password && share.password !== (password ?? "")) throw new DriveApiError("Invalid password", 401, "INVALID_PASSWORD");
    const accessToken = `mock_token_${shareId}_${Date.now()}`; shareTokens.set(shareId, accessToken); return { accessToken };
  },
  async getShareDownload(shareId: string, accessToken?: string): Promise<ShareDownloadResult> {
    const share = shares.find((entry) => entry.id === shareId); if (!share) throw new DriveApiError(shareMessage("not_found") ?? "Share not found", 404, "SHARE_NOT_FOUND");
    const status = shareStatus(share); if (status === "expired") throw new DriveApiError(shareMessage("expired") ?? "Share expired", 410, "SHARE_EXPIRED"); if (status === "depleted") throw new DriveApiError(shareMessage("depleted") ?? "Download limit reached", 410, "DOWNLOAD_LIMIT");
    if (share.password) { const token = shareTokens.get(shareId); if (!token || token !== accessToken) throw new DriveApiError("Invalid access token, verify password first", 401, "ACCESS_DENIED"); }
    share.downloadCount += 1; const file = share.fileId ? findFile(share.fileId) : null; const folder = share.folderPath?.split("/").filter(Boolean).slice(-1)[0] || "shared-folder";
    return { downloadUrl: file?.s3Uri || `mock://download/${share.id}/${encodeURIComponent(file?.name || `${folder}.zip`)}`, fileName: file?.name || `${folder}.zip`, downloadCount: share.downloadCount };
  },
  async getGuide(): Promise<GuideData> { return guide; },
};
