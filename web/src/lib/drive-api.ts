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
  ShareStats,
  UploadTicket,
} from "@/types/drive";

const toQuery = (path: string, options?: { recursive?: boolean; limit?: number; offset?: number }) => {
  const params = new URLSearchParams({ path: normalizePath(path) });
  if (options?.recursive) params.set("recursive", "true");
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.offset !== undefined) params.set("offset", String(options.offset));
  return params.toString();
};

type ShareStatsResponse = Omit<ShareStats, "ipBreakdown" | "userAgentBreakdown"> & {
  ipBreakdown?: ShareStats["ipBreakdown"];
  userAgentBreakdown?: ShareStats["userAgentBreakdown"];
  ipStats?: ShareStats["ipBreakdown"];
  userAgentStats?: ShareStats["userAgentBreakdown"];
};

type BundleCurrentResponse = {
  prefix: string;
  currentVersion: {
    versionId: string;
    previousVersionId: string | null;
    machineId: string;
    hash: string;
    fileCount: number;
    totalSize: number;
    pushedAt: string;
  } | null;
};

type BundleManifestResponse = {
  prefix: string;
  versionId: string;
  manifest: unknown;
};

export type DriveToken = {
  id: string;
  label: string | null;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  expired: boolean;
};

const normalizeShareStats = (stats: ShareStatsResponse): ShareStats => ({
  ...stats,
  fileBreakdown: stats.fileBreakdown ?? [],
  ipBreakdown: stats.ipBreakdown ?? stats.ipStats ?? [],
  userAgentBreakdown: stats.userAgentBreakdown ?? stats.userAgentStats ?? [],
});

const asGuideData = (value: unknown): GuideData | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GuideData>;
  return typeof candidate.title === "string" && typeof candidate.intro === "string" && Array.isArray(candidate.sections)
    ? (candidate as GuideData)
    : null;
};

export const driveApi = {
  isMockMode,
  listFiles: (path: string, options?: { recursive?: boolean; limit?: number; offset?: number }) =>
    withMockFallback(
      () => apiFetchJson<{ files: DriveFile[]; path: string; limit?: number; offset?: number }>(`/api/public/v1/files?${toQuery(path, options)}`),
      () => mockDriveApi.listFiles(path, options),
    ),
  getBundleCurrent: (prefix: string) =>
    apiFetchJson<BundleCurrentResponse>(`/api/public/v1/bundles/current?${new URLSearchParams({ prefix: normalizePath(prefix) }).toString()}`),
  getBundleManifest: (prefix: string, versionId: string) =>
    apiFetchJson<BundleManifestResponse>(`/api/public/v1/bundles/manifest?${new URLSearchParams({ prefix: normalizePath(prefix), versionId }).toString()}`),
  searchFiles: (query: string, limit = 50) =>
    withMockFallback(
      () => apiFetchJson<{ files: DriveFile[]; query: string; count: number }>(`/api/public/v1/files/search?${new URLSearchParams({ q: query, limit: String(limit) }).toString()}`),
      () => mockDriveApi.searchFiles(query, limit),
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
  previewFile: (fileId: string) =>
    apiFetchJson<{
      id: string;
      name: string;
      contentType: string | null;
      size: number;
      downloadUrl: string;
      expiresInSecs: number;
    }>(`/api/public/v1/files/${fileId}/preview`),
  deleteFile: (fileId: string) =>
    withMockFallback(
      () => apiFetchJson<{ deleted: number }>(`/api/public/v1/files/${fileId}`, { method: "DELETE" }),
      () => mockDriveApi.deleteFile(fileId),
    ),
  deleteFiles: (ids: string[]) =>
    apiFetchJson<{
      requested: number;
      trashedFiles: number;
      trashedFolders: number;
      trashedIds: string[];
      failures: Array<{ id: string; error: string; message: string }>;
    }>("/api/public/v1/files/batch", { method: "DELETE", body: JSON.stringify({ ids }) }),
  listTrash: () =>
    apiFetchJson<{
      files: Array<DriveFile & { deletedAt: string | null; retention: { deletedAt: string; purgesAt: string; daysLeft: number } | null }>;
      retentionDays: number;
    }>("/api/public/v1/files/trash"),
  restoreFile: (fileId: string) =>
    apiFetchJson<{ restored: number; file: DriveFile }>(`/api/public/v1/files/${fileId}/restore`, { method: "POST" }),
  purgeFile: (fileId: string) =>
    apiFetchJson<{ purged: number; objectsRemoved: number }>(`/api/public/v1/files/${fileId}/purge`, { method: "DELETE" }),
  mintToken: (input: { label?: string; scopes: string[]; pathPrefix?: string; expiresInDays?: number }) =>
    apiFetchJson<{ token: string; hint: string; tokenInfo: DriveToken }>("/api/public/v1/tokens", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listTokens: () => apiFetchJson<{ tokens: DriveToken[] }>("/api/public/v1/tokens"),
  revokeToken: (tokenId: string) =>
    apiFetchJson<{ revoked: DriveToken }>(`/api/public/v1/tokens/${tokenId}`, { method: "DELETE" }),
  moveFiles: (ids: string[], parentPath: string) =>
    apiFetchJson<{
      requested: number;
      moved: number;
      movedIds: string[];
      parentPath: string;
      failures: Array<{ id: string; error: string; message: string }>;
    }>("/api/public/v1/files/batch", { method: "PATCH", body: JSON.stringify({ ids, parentPath }) }),
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
  getShareStats: (shareId: string) =>
    withMockFallback(
      async () => normalizeShareStats(await apiFetchJson<ShareStatsResponse>(`/api/public/v1/shares/${shareId}/stats`)),
      () => mockDriveApi.getShareStats(shareId),
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
