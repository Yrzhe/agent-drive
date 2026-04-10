import { apiFetchJson, isMockMode, withMockFallback } from "@/lib/api-client";
import { mockDriveApi } from "@/lib/mock-data";
import { normalizePath } from "@/lib/path-utils";
import type {
  CreateShareInput,
  DriveFile,
  GuideData,
  GuideSection,
  ShareAccessResult,
  ShareDownloadResult,
  ShareInfo,
  ShareLink,
  UploadTicket,
} from "@/types/drive";

const toQuery = (path: string) => new URLSearchParams({ path: normalizePath(path) }).toString();

const asGuideData = (value: unknown): GuideData | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GuideData>;
  return typeof candidate.title === "string" && typeof candidate.intro === "string" && Array.isArray(candidate.sections)
    ? (candidate as GuideData)
    : null;
};

export const driveApi = {
  isMockMode,
  listFiles: (path: string) =>
    withMockFallback(
      () => apiFetchJson<{ files: DriveFile[]; path: string }>(`/api/public/v1/files?${toQuery(path)}`),
      () => mockDriveApi.listFiles(path),
    ),
  requestUpload: (input: { filename: string; contentType: string; size: number; path: string }) =>
    withMockFallback(
      () => apiFetchJson<UploadTicket>("/api/public/v1/files/upload", { method: "POST", body: JSON.stringify(input) }),
      () => mockDriveApi.requestUpload(input),
    ),
  completeUpload: (fileId: string, filename: string, path: string) =>
    withMockFallback(
      () => apiFetchJson<{ file: DriveFile }>("/api/public/v1/files/upload/complete", { method: "POST", body: JSON.stringify({ fileId, filename, path }) }),
      () => mockDriveApi.completeUpload(fileId),
    ),
  createFolder: (name: string, parentPath: string) =>
    withMockFallback(
      () => apiFetchJson<{ folder: DriveFile }>("/api/public/v1/folders", { method: "POST", body: JSON.stringify({ name, path: parentPath }) }),
      () => mockDriveApi.createFolder(name, parentPath),
    ),
  renameFile: (fileId: string, payload: { name?: string; parentPath?: string }) =>
    withMockFallback(
      () => apiFetchJson<{ file: DriveFile }>(`/api/public/v1/files/${fileId}`, { method: "PATCH", body: JSON.stringify(payload) }),
      () => mockDriveApi.renameFile(fileId, payload),
    ),
  deleteFile: (fileId: string) =>
    withMockFallback(
      () => apiFetchJson<{ deleted: number }>(`/api/public/v1/files/${fileId}`, { method: "DELETE" }),
      () => mockDriveApi.deleteFile(fileId),
    ),
  listShares: () => withMockFallback(() => apiFetchJson<{ shares: ShareLink[] }>("/api/public/v1/shares"), () => mockDriveApi.listShares()),
  createShare: (input: CreateShareInput) =>
    withMockFallback(
      () => apiFetchJson<{ share: ShareLink }>("/api/public/v1/shares", { method: "POST", body: JSON.stringify(input) }),
      () => mockDriveApi.createShare(input),
    ),
  deleteShare: (shareId: string) =>
    withMockFallback(
      () => apiFetchJson<{ success: boolean }>(`/api/public/v1/shares/${shareId}`, { method: "DELETE" }),
      async () => ({ success: true }),
    ),
  getShareInfo: (shareId: string) =>
    withMockFallback(
      async () => {
        const body = await apiFetchJson<{
          id: string;
          type: "file" | "folder";
          name: string;
          size: number;
          fileCount: number;
          hasPassword: boolean;
          maxDownloads: number | null;
          downloadCount: number;
          expiresAt: string | null;
          expired: boolean;
          exhausted: boolean;
          createdAt: string;
        }>(`/api/public/s/${shareId}`);
        const status = body.expired ? "expired" : body.exhausted ? "depleted" : "active";
        return {
          id: body.id,
          file: body.type === "file" ? { id: "", name: body.name, path: "", parentPath: "", isFolder: false as boolean, size: body.size, contentType: null as string | null, createdAt: body.createdAt, updatedAt: body.createdAt } : null,
          folderPath: body.type === "folder" ? body.name : null,
          requiresPassword: body.hasPassword,
          maxDownloads: body.maxDownloads,
          downloadCount: body.downloadCount,
          expiresAt: body.expiresAt,
          status,
        } as ShareInfo;
      },
      () => mockDriveApi.getShareInfo(shareId),
    ),
  accessShare: (shareId: string, password?: string) =>
    withMockFallback(
      async () => {
        const body = await apiFetchJson<{ accessToken?: string; token?: string }>(`/api/public/s/${shareId}/access`, {
          method: "POST",
          body: JSON.stringify({ password }),
        });
        return { accessToken: body.accessToken ?? body.token ?? "" } as ShareAccessResult;
      },
      () => mockDriveApi.accessShare(shareId, password),
    ),
  getShareFiles: (shareId: string, accessToken: string) =>
    withMockFallback(
      async () => {
        const body = await apiFetchJson<{ files: Array<{ id: string; name: string; path: string; isFolder: boolean; size: number; contentType: string | null }> }>(
          `/api/public/s/${shareId}/files`,
          { method: "GET", headers: { "x-access-token": accessToken } },
        );
        return body.files;
      },
      async () => [],
    ),
  getShareDownload: (shareId: string, accessToken?: string, fileId?: string) =>
    withMockFallback(
      async () => {
        const query = fileId ? `?fileId=${encodeURIComponent(fileId)}` : "";
        const body = await apiFetchJson<{ downloadUrl?: string; url?: string; filename?: string; fileName?: string; downloadCount?: number; size?: number }>(
          `/api/public/s/${shareId}/download${query}`,
          { method: "GET", headers: accessToken ? { "x-access-token": accessToken } : {} },
        );
        return { downloadUrl: body.downloadUrl ?? body.url ?? "", fileName: body.filename ?? body.fileName ?? "download", downloadCount: body.downloadCount ?? 0 } as ShareDownloadResult;
      },
      () => mockDriveApi.getShareDownload(shareId, accessToken),
    ),
  getGuide: () =>
    withMockFallback(
      async () => {
        const body = await apiFetchJson<Record<string, unknown>>("/api/public/guide");
        const parsed = asGuideData(body);
        if (parsed) return parsed;

        const name = typeof body.name === "string" ? body.name : "Agent Drive";
        const description = typeof body.description === "string" ? body.description : "";
        const sections: GuideSection[] = [];
        const skipKeys = new Set(["name", "version", "description"]);

        for (const [key, value] of Object.entries(body)) {
          if (skipKeys.has(key) || value == null) continue;
          const title = key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).trim();
          if (typeof value === "string") {
            sections.push({ title, content: value });
          } else if (Array.isArray(value)) {
            sections.push({ title, content: value.filter((v): v is string => typeof v === "string").join("\n") });
          } else if (typeof value === "object") {
            const lines = Object.entries(value as Record<string, string>).map(([k, v]) => `${k}: ${v}`);
            sections.push({ title, content: lines.join("\n") });
          }
        }

        return { title: name, intro: description, sections } as GuideData;
      },
      () => mockDriveApi.getGuide(),
    ),
};
