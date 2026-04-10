import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DriveApiError } from "@/lib/api-client";
import { driveApi } from "@/lib/drive-api";
import type { ShareInfo } from "@/types/drive";

interface SharedFile {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  size: number;
  contentType: string | null;
}

const formatDate = (value: string) => new Date(value).toLocaleString();
const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
const statusText = (share: ShareInfo) =>
  share.status === "expired" ? "This share link has expired" : share.status === "depleted" ? "This share link reached the download limit" : share.status === "not_found" ? "Share link not found" : "Ready to download";

export default function ShareDownloadPage() {
  const { shareId = "" } = useParams();
  const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);

  const isFolder = shareInfo ? !shareInfo.file : false;

  const refreshShare = useCallback(async () => {
    if (!shareId) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      setShareInfo(await driveApi.getShareInfo(shareId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load share info");
    } finally {
      setLoading(false);
    }
  }, [shareId]);

  useEffect(() => {
    void refreshShare();
  }, [refreshShare]);

  const ensureAccessToken = async (): Promise<string> => {
    if (accessToken) return accessToken;
    const result = await driveApi.accessShare(shareId, password || undefined);
    setAccessToken(result.accessToken);
    return result.accessToken;
  };

  const handleAccess = async () => {
    if (!shareInfo) return;
    setErrorMessage(null);
    try {
      const token = await ensureAccessToken();
      if (isFolder) {
        setLoadingFiles(true);
        const files = await driveApi.getShareFiles(shareId, token);
        setSharedFiles(files.filter((f) => !f.isFolder));
        setLoadingFiles(false);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Password verification failed");
      setLoadingFiles(false);
    }
  };

  const handleDownloadFile = async (fileId?: string, fileName?: string) => {
    if (!shareInfo) return;
    const dlId = fileId ?? "single";
    setDownloadingId(dlId);
    setErrorMessage(null);
    try {
      const token = await ensureAccessToken();
      const result = await driveApi.getShareDownload(shareId, token, fileId);
      const response = result.downloadUrl.startsWith("mock://")
        ? new Response(`Mock content for ${result.fileName}`, { headers: { "content-type": "text/plain" } })
        : await fetch(result.downloadUrl);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName ?? result.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      setErrorMessage(error instanceof DriveApiError || error instanceof Error ? error.message : "Download failed");
    } finally {
      setDownloadingId(null);
      await refreshShare();
    }
  };

  const needsPassword = shareInfo?.status === "active" && shareInfo.requiresPassword && !accessToken;
  const needsFileList = shareInfo?.status === "active" && isFolder && accessToken && sharedFiles.length === 0 && !loadingFiles;

  useEffect(() => {
    if (needsFileList) {
      setLoadingFiles(true);
      void driveApi.getShareFiles(shareId, accessToken).then((files) => {
        setSharedFiles(files.filter((f) => !f.isFolder));
        setLoadingFiles(false);
      }).catch(() => setLoadingFiles(false));
    }
  }, [needsFileList, shareId, accessToken]);

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto w-full max-w-xl space-y-4">
        <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
          <h1 className="text-lg font-semibold text-slate-900">Share Download</h1>
          <div className="flex items-center gap-2 text-sm"><Link className="text-slate-600 hover:text-slate-900" to="/guide">Guide</Link><Link className="text-slate-600 hover:text-slate-900" to="/">Dashboard</Link></div>
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          {loading ? <p className="text-sm text-slate-600">Loading share info...</p> : !shareInfo ? <p className="text-sm text-red-700">Unable to read share information</p> : (
            <div className="space-y-4">
              <div><p className="text-sm text-slate-500">Share ID</p><p className="font-mono text-sm text-slate-800">{shareInfo.id}</p></div>
              <div><p className="text-sm text-slate-500">Target</p><p className="text-slate-900">{shareInfo.file ? `File: ${shareInfo.file.name}` : `Folder: ${shareInfo.folderPath ?? "Unknown"}`}</p></div>
              <div className="text-sm text-slate-700">
                <p>Status: {statusText(shareInfo)}</p>
                <p>Downloads: {shareInfo.downloadCount}{shareInfo.maxDownloads !== null ? ` / ${shareInfo.maxDownloads}` : ""}</p>
                <p>Password protected: {shareInfo.requiresPassword ? "Yes" : "No"}</p>
                <p>Expires: {shareInfo.expiresAt ? formatDate(shareInfo.expiresAt) : "Never"}</p>
              </div>

              {needsPassword ? (
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <label className="block text-sm font-medium text-slate-700" htmlFor="share-password-input">Enter password to access files</label>
                  <div className="flex flex-wrap gap-2">
                    <input className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" id="share-password-input" onChange={(event) => setPassword(event.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void handleAccess(); }} placeholder="Enter share password" type="password" value={password} />
                    <button className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white" onClick={() => { void handleAccess(); }} type="button">Verify</button>
                  </div>
                </div>
              ) : null}

              {shareInfo.status === "active" && !isFolder ? (
                <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300" disabled={downloadingId !== null} onClick={() => { void handleDownloadFile(); }} type="button">{downloadingId ? "Downloading..." : "Download"}</button>
              ) : null}

              {shareInfo.status === "active" && isFolder && accessToken ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-slate-700">Files in this share</h3>
                  {loadingFiles ? <p className="text-sm text-slate-500">Loading file list...</p> : sharedFiles.length === 0 ? <p className="text-sm text-slate-500">No files found.</p> : (
                    <div className="space-y-1">
                      {sharedFiles.map((file) => (
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2" key={file.id}>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-slate-900">{file.path || file.name}</p>
                            <p className="text-xs text-slate-500">{formatSize(file.size)}</p>
                          </div>
                          <button className="shrink-0 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:bg-blue-300" disabled={downloadingId === file.id} onClick={() => { void handleDownloadFile(file.id, file.name); }} type="button">{downloadingId === file.id ? "..." : "Download"}</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              {shareInfo.status === "active" && isFolder && !accessToken && !needsPassword ? (
                <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700" onClick={() => { void handleAccess(); }} type="button">View Files</button>
              ) : null}

              {shareInfo.status !== "active" ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{shareInfo.message ?? statusText(shareInfo)}</div>
              ) : null}
            </div>
          )}

          {errorMessage ? <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</div> : null}
        </section>
      </div>
    </main>
  );
}
